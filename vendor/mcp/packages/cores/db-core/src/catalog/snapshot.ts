import type { ErrorFactory } from "@sezzlee/mcp-core";
import { truncateWellFormed } from "@sezzlee/mcp-core";
import type { DbErrorCode } from "../errors.js";
import type { DbLimits } from "../limits.js";
import type {
  CatalogColumn,
  CatalogObject,
  ObjectKind,
} from "../model/catalog.js";
import type { Dialect } from "../model/dialect.js";
import { stableHash } from "../primitives/hash.js";
import type { QueryRunner } from "../query/execute.js";
import type { DbVocabulary } from "../vocabulary.js";
import {
  buildIndex,
  type IndexedColumn,
  type InvertedIndex,
} from "../search/inverted.js";
import { introspect } from "./introspect.js";

export interface SnapshotObject {
  readonly schema: string;
  readonly name: string;
  readonly kind: ObjectKind;
  readonly description?: string;
  readonly columns: readonly IndexedColumn[];
}

export interface CatalogSnapshot {
  readonly objects: readonly SnapshotObject[];
  readonly index: InvertedIndex;
  readonly complete: boolean;
  readonly coverageEndsAt?: string;
  readonly indexedAt: number;
  readonly digest: string;
}

export interface CatalogCache {
  read(refresh: boolean, signal?: AbortSignal): Promise<CatalogSnapshot>;
  clear(): void;
}

export interface CatalogCacheSpec<TConfig> {
  readonly runner: QueryRunner;
  readonly dialect: Dialect<TConfig>;
  readonly limits: DbLimits;
  readonly fail: ErrorFactory<DbErrorCode>;
  readonly vocabulary: DbVocabulary<string>;
  readonly now?: () => number;
}

const qualify = (ref: { schema: string; name: string }): string =>
  `${ref.schema}.${ref.name}`;

/**
 * Guard: the boundary is the last object the column read reached, not the
 * object it stopped on. The column read is not scoped to the object prefix, so
 * when both reads are cut it can stop on an object past the last one read —
 * looking that object up finds nothing and turns a partial index into a refusal.
 */
function lastCoveredIndex(
  objects: readonly CatalogObject[],
  covered: ReadonlyMap<string, unknown>,
): number {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (covered.has(qualify(objects[index] as CatalogObject))) {
      return index;
    }
  }
  return -1;
}

function clamp(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const kept = truncateWellFormed(text, limit).trim();
  return kept.length === 0 ? undefined : kept;
}

/**
 * Reads the catalogue once and turns it into a searchable snapshot.
 *
 * Guard: the snapshot covers a prefix of the catalogue and every object in it is
 * whole. When the column read was cut, the trailing object is dropped entirely
 * rather than indexed with half its columns — a half-indexed table answers a
 * column search with silence while still appearing in other results, which reads
 * as "that column does not exist" instead of "I did not look".
 *
 * Objects and columns are two reads, not one: a single denormalised read repeats
 * each object's description on every column row, measured at about 5.9 MB of
 * pure repetition on an 11 518-column catalogue.
 */
export async function buildSnapshot<TConfig>(
  spec: CatalogCacheSpec<TConfig>,
  signal?: AbortSignal,
): Promise<CatalogSnapshot> {
  const { runner, dialect, limits, fail } = spec;
  const scope = {
    maxObjects: limits.maxIndexObjects,
    maxRows: limits.maxIndexRows,
  };

  const objectRead = await introspect(
    runner,
    dialect.introspection.catalogObjects(scope),
    signal,
  );
  const objectsCut =
    objectRead.more || objectRead.rows.length > limits.maxIndexObjects;
  const objects: readonly CatalogObject[] = objectRead.rows.slice(
    0,
    limits.maxIndexObjects,
  );

  const columnRead = await introspect(
    runner,
    dialect.introspection.catalogColumns(scope),
    signal,
  );
  const columnsCut =
    columnRead.more || columnRead.rows.length > limits.maxIndexRows;
  let rows: readonly CatalogColumn[] = columnRead.rows.slice(
    0,
    limits.maxIndexRows,
  );

  if (columnsCut && rows.length > 0) {
    const trailing = qualify(rows[rows.length - 1] as CatalogColumn);
    rows = rows.filter((row) => qualify(row) !== trailing);
  }

  const grouped = new Map<string, IndexedColumn[]>();
  for (const row of rows) {
    const key = qualify(row);
    let bucket = grouped.get(key);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(key, bucket);
    }
    const description = clamp(row.description, limits.maxDescriptionChars);
    bucket.push({
      name: row.column,
      ...(description === undefined ? {} : { description }),
    });
  }

  const boundary = columnsCut
    ? lastCoveredIndex(objects, grouped)
    : objects.length - 1;

  if (columnsCut && boundary < 0) {
    throw fail(
      "resource_limit",
      `The first object alone carries more than ${limits.maxIndexRows} columns, so no whole object fits the index.`,
      `Call ${spec.vocabulary.describeTool} with a name you already know instead.`,
    );
  }

  const kept: readonly SnapshotObject[] = objects
    .slice(0, boundary + 1)
    .map((entry) => {
      const description = clamp(entry.description, limits.maxDescriptionChars);
      return {
        schema: entry.schema,
        name: entry.name,
        kind: entry.kind,
        ...(description === undefined ? {} : { description }),
        columns: grouped.get(qualify(entry)) ?? [],
      };
    });

  const complete = !objectsCut && !columnsCut;
  const edge = kept[kept.length - 1];
  return {
    objects: kept,
    index: buildIndex(kept),
    complete,
    ...(complete || edge === undefined
      ? {}
      : { coverageEndsAt: qualify(edge) }),
    indexedAt: (spec.now ?? Date.now)(),
    digest: stableHash(
      kept.map((entry) => [
        qualify(entry),
        entry.columns.map((column) => column.name),
      ]),
    ),
  };
}

/**
 * Guard: one build at a time. Two searches arriving together must share the
 * in-flight read, or a large catalogue is fetched twice over a pool that holds
 * one connection and the second caller waits for a read it did not need.
 */
export function createCatalogCache<TConfig>(
  spec: CatalogCacheSpec<TConfig>,
): CatalogCache {
  const now = spec.now ?? Date.now;
  let held: CatalogSnapshot | undefined;
  let building: Promise<CatalogSnapshot> | undefined;

  return {
    clear: () => {
      held = undefined;
    },
    read: async (refresh, signal) => {
      const fresh =
        held !== undefined &&
        now() - held.indexedAt < spec.limits.catalogIndexTtlMs;
      if (!refresh && fresh && held !== undefined) {
        return held;
      }
      building ??= buildSnapshot(spec, signal).finally(() => {
        building = undefined;
      });
      held = await building;
      return held;
    },
  };
}
