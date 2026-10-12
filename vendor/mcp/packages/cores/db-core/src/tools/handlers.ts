import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  createPageBudget,
  fold,
  guard,
  json,
  measureJson,
  type ErrorNormalizer,
  type UnexpectedErrorReporter,
} from "@sezzlee/mcp-core";
import { introspect, introspectOne } from "../catalog/introspect.js";
import type { SnapshotObject } from "../catalog/snapshot.js";
import { stableHash } from "../primitives/hash.js";
import {
  catalogFingerprint,
  decodeCatalogCursor,
  encodeCatalogCursor,
} from "../search/cursor.js";
import { likeMatches } from "../search/pattern.js";
import { rank, type MatchReason } from "../search/rank.js";
import type { KeyEntry } from "../model/catalog.js";
import type { PrincipalPosture } from "../model/dialect.js";
import type { ColumnDescriptor, JsonScalar } from "../model/value.js";
import type { QueryResult } from "../model/sql.js";
import type { DbSource } from "../source.js";
import { encodeRow } from "../values/encode.js";
import {
  type Definitions,
  type ToolHandlers,
  type ToolInput,
  type ToolName,
} from "./definitions.js";

interface WireColumn {
  readonly name: string;
  readonly kind: string;
  readonly nativeType: string;
  readonly nullable: boolean;
  readonly precision?: number;
  readonly scale?: number;
  readonly lossy?: string;
}

/**
 * Guard: precision and scale are published for exact numerics only. There they
 * are part of the type, and the only way to tell a column that is flagged
 * `lossy: "precision"` from one that is not; on an integer or a timestamp they
 * are engine bookkeeping an agent would read as a constraint.
 */
const wireColumn = (column: ColumnDescriptor): WireColumn => ({
  name: column.name,
  kind: column.kind,
  nativeType: column.nativeType,
  nullable: column.nullable,
  ...(column.kind === "decimal" && column.precision !== undefined
    ? { precision: column.precision }
    : {}),
  ...(column.kind === "decimal" && column.scale !== undefined
    ? { scale: column.scale }
    : {}),
  ...(column.lossy === undefined ? {} : { lossy: column.lossy }),
});

interface RowPage {
  readonly columns: readonly WireColumn[];
  readonly rows: readonly (readonly JsonScalar[])[];
  readonly returnedCount: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly truncationReason?: "maxPayloadBytes" | "maxRows";
  readonly hint?: string;
}

export function createHandlers<TConfig>(
  source: DbSource<TConfig>,
  normalize: ErrorNormalizer,
  options: {
    readonly report?: UnexpectedErrorReporter;
    readonly principalGate?: "query" | "every_read";
  } = {},
): ToolHandlers {
  const { dialect, vocabulary, fail, limits, runner, redact } = source;
  const { report } = options;
  const everyRead = options.principalGate === "every_read";

  async function requirePermittedPrincipal(signal?: AbortSignal) {
    const posture = await source.principal(signal);
    if (!queryPermitted(posture, source.sessionIntent)) {
      throw fail(
        "write_not_permitted",
        posture === "unknown"
          ? "The connected principal's privileges could not be verified, so queries are disabled."
          : `The connected principal is ${posture === "administrator" ? "an administrator" : "able to write"}, so queries are disabled.`,
        vocabulary.readOnlyRecovery,
      );
    }
  }

  const guarded = <K extends ToolName>(
    tool: K,
    handler: (
      args: ToolInput<K>,
      signal?: AbortSignal,
    ) => Promise<CallToolResult>,
  ) =>
    guard<Definitions, K>(
      { tool, fail, redact, ...(report === undefined ? {} : { report }) },
      async (args, _tool, signal) => handler(args, signal),
      normalize,
    );

  /**
   * Guard: the envelope is measured with no rows and the worst-case truncation
   * fields present, so the reserve already covers the flags a refusal will add.
   * Admitting rows first and hoping they fit is what makes a page overshoot.
   */
  function assemble(result: QueryResult): RowPage {
    const columns = result.columns.map(wireColumn);
    const kinds = result.columns.map((column) => column.kind);
    const policy = {
      maxTextChars: limits.maxTextChars,
      maxBinaryBytes: limits.maxBinaryBytes,
    };
    const reserveBytes = measureJson({
      columns,
      rows: [],
      returnedCount: 0,
      complete: false,
      truncated: true,
      truncationReason: "maxPayloadBytes",
      hint: vocabulary.tooManyRowsRecovery,
    });
    const budget = createPageBudget({
      maxBytes: limits.maxPayloadBytes,
      reserveBytes,
    });
    const rows: (readonly JsonScalar[])[] = [];
    let refused = false;
    for (const row of result.rows) {
      const encoded = encodeRow(row, kinds, policy);
      if (!budget.admit(encoded)) {
        refused = true;
        break;
      }
      rows.push(encoded);
    }
    if (rows.length === 0 && result.rows.length > 0) {
      throw fail(
        "resource_limit",
        `The first row does not fit in the ${limits.maxPayloadBytes} byte response budget.`,
        "Select fewer columns, or narrow the wide ones.",
      );
    }
    const truncated = refused || result.more;
    return {
      columns,
      rows,
      returnedCount: rows.length,
      complete: !truncated,
      truncated,
      ...(refused
        ? { truncationReason: "maxPayloadBytes" as const }
        : result.more
          ? { truncationReason: "maxRows" as const }
          : {}),
      ...(truncated ? { hint: vocabulary.tooManyRowsRecovery } : {}),
    };
  }

  return {
    describe_connection: guarded(
      "describe_connection",
      async (_args, signal) => {
        const facts = await introspectOne(
          runner,
          dialect.introspection.server(),
          signal,
        );
        const posture = await source.principal(signal);
        const { display } = source.profile;
        return json({
          alias: display.alias,
          engine: display.engine,
          dialect: dialect.id,
          ...(facts === undefined
            ? {}
            : { engineVersion: facts.engineVersion }),
          catalog: facts?.catalog ?? display.catalog ?? null,
          principal: facts?.principal ?? display.principal ?? null,
          readOnly: {
            principal:
              "The database principal decides what is readable; this server issues no writes.",
            sessionIntent: source.sessionIntent,
            principalPosture: posture,
            statementGuard: "advisory",
            note: vocabulary.readOnlyRecovery,
          },
          limits: {
            maxRows: limits.maxRows,
            defaultRows: limits.defaultRows,
            maxColumns: limits.maxColumns,
            maxPayloadBytes: limits.maxPayloadBytes,
            queryTimeoutMs: limits.queryTimeoutMs,
          },
        });
      },
    ),

    search_catalog: guarded("search_catalog", async (args, signal) => {
      if (everyRead) await requirePermittedPrincipal(signal);
      const snapshot = await source.catalog.read(args.refresh ?? false, signal);
      const maxResults = args.maxResults ?? limits.defaultListResults;
      const includeViews = args.includeViews ?? true;
      const query = args.query?.trim() ?? "";
      const name = source.profile.display.catalog ?? null;

      const scored: readonly {
        readonly document: number;
        readonly score?: number;
        readonly matched?: readonly MatchReason[];
      }[] =
        query.length === 0
          ? snapshot.objects.map((_, document) => ({ document }))
          : rank(snapshot.index, query, {
              maxTerms: limits.maxQueryTerms,
              maxExpansions: limits.maxExpansions,
              maxReasons: limits.maxMatchReasons,
            });

      const keeps = (entry: SnapshotObject): boolean =>
        (includeViews || entry.kind !== "view") &&
        (args.schema === undefined ||
          fold(entry.schema) === fold(args.schema)) &&
        (args.namePattern === undefined ||
          likeMatches(args.namePattern, entry.name));

      const matches = scored.filter((candidate) =>
        keeps(snapshot.objects[candidate.document] as SnapshotObject),
      );

      const fingerprint = catalogFingerprint(
        name ?? "",
        snapshot.digest,
        stableHash([
          query,
          args.schema ?? null,
          args.namePattern ?? null,
          includeViews,
        ]),
      );
      const start =
        args.cursor === undefined
          ? 0
          : decodeCatalogCursor(
              args.cursor,
              fingerprint,
              fail,
              vocabulary.listTool,
            );

      const facts = {
        name,
        indexedObjects: snapshot.objects.length,
        complete: snapshot.complete,
        ...(snapshot.coverageEndsAt === undefined
          ? {}
          : { coverageEndsAt: snapshot.coverageEndsAt }),
        indexedAt: new Date(snapshot.indexedAt).toISOString(),
        ageMs: Math.max(0, Date.now() - snapshot.indexedAt),
      };

      const coverage = snapshot.complete
        ? undefined
        : `The index covers ${snapshot.objects.length} ${vocabulary.objectLabel} names in catalogue order and stops at ${snapshot.coverageEndsAt}; a name after that point is not searchable. Narrow with ${vocabulary.schemaLabel} and search again, or call ${vocabulary.describeTool} directly if you already know the name.`;

      const reserveBytes = measureJson({
        catalog: facts,
        results: [],
        returnedCount: 0,
        complete: false,
        truncated: true,
        truncationReason: "maxPayloadBytes",
        nextCursor: encodeCatalogCursor(fingerprint, matches.length),
        hint: `${coverage ?? ""} Read the next page with nextCursor.`,
      });
      const budget = createPageBudget({
        maxBytes: limits.maxPayloadBytes,
        reserveBytes,
      });

      const results = [];
      let refused = false;
      for (const candidate of matches.slice(start, start + maxResults)) {
        const entry = snapshot.objects[candidate.document] as SnapshotObject;
        const wire = {
          schema: entry.schema,
          name: entry.name,
          kind: entry.kind,
          ...(candidate.score === undefined
            ? {}
            : { score: Math.round(candidate.score * 1_000) / 1_000 }),
          ...(entry.description === undefined
            ? {}
            : { description: entry.description }),
          ...(candidate.matched === undefined
            ? {}
            : { matched: candidate.matched }),
        };
        if (!budget.admit(wire)) {
          refused = true;
          break;
        }
        results.push(wire);
      }

      /**
       * Guard: the next position counts what was sent, not what was asked for.
       * The byte budget can stop at 31 of the 50 requested, and a cursor that
       * resumes at 50 drops the 19 in between with nothing anywhere to say so.
       */
      const next = start + results.length;
      const overflowed = next < matches.length;
      const truncated = refused || overflowed;
      const hint = [
        coverage,
        overflowed ? "Read the next page with nextCursor." : undefined,
      ]
        .filter((line) => line !== undefined)
        .join(" ");

      return json({
        catalog: facts,
        results,
        returnedCount: results.length,
        complete: !truncated,
        truncated,
        ...(refused
          ? { truncationReason: "maxPayloadBytes" as const }
          : overflowed
            ? { truncationReason: "maxResults" as const }
            : {}),
        ...(overflowed
          ? { nextCursor: encodeCatalogCursor(fingerprint, next) }
          : {}),
        ...(hint.length === 0 ? {} : { hint }),
      });
    }),

    describe_table: guarded("describe_table", async (args, signal) => {
      if (everyRead) await requirePermittedPrincipal(signal);
      const ref = { schema: args.schema, name: args.table };
      const columns = await introspect(
        runner,
        dialect.introspection.columns(ref),
        signal,
      );
      if (columns.rows.length === 0) {
        throw fail(
          "object_not_found",
          `No readable ${vocabulary.objectLabel} named ${args.schema}.${args.table}.`,
          `Call ${vocabulary.listTool} for the names this connection can read.`,
        );
      }
      /**
       * Guard: a partial column list is refused, never returned. The engine
       * reads one past the limit, so `more` and the row count both answer the
       * same question and the refusal cannot be outrun by the driver's own cap.
       */
      if (columns.more || columns.rows.length > limits.maxColumns) {
        throw fail(
          "resource_limit",
          `${args.schema}.${args.table} has more than ${limits.maxColumns} columns.`,
          "Query the columns you need by name instead.",
        );
      }
      const keys = await introspect(
        runner,
        dialect.introspection.keys(ref),
        signal,
      );
      /**
       * Guard: keys are supplementary, so a cut list is reported rather than
       * refused — but it has to be reported. A foreign key the agent never sees
       * is a join it writes wrong, with no error anywhere to show for it.
       */
      const keysTruncated = keys.more || keys.rows.length > limits.maxKeys;
      const of = (kind: KeyEntry["kind"]) =>
        keys.rows.slice(0, limits.maxKeys).filter((key) => key.kind === kind);
      const primary = of("primary")[0];
      return json({
        schema: args.schema,
        table: args.table,
        columns: columns.rows.map(wireColumn),
        ...(primary === undefined ? {} : { primaryKey: primary.columns }),
        uniqueKeys: of("unique").map((key) => ({
          name: key.name,
          columns: key.columns,
        })),
        foreignKeys: of("foreign").map((key) => ({
          name: key.name,
          columns: key.columns,
          referencedSchema: key.referencedSchema ?? null,
          referencedTable: key.referencedTable ?? null,
          referencedColumns: key.referencedColumns ?? [],
        })),
        keysComplete: !keysTruncated,
        ...(keysTruncated
          ? {
              truncationReason: "maxKeys" as const,
              hint: `Only the first ${limits.maxKeys} constraints are listed; the rest are not shown.`,
            }
          : {}),
      });
    }),

    run_query: guarded("run_query", async (args, signal) => {
      const outcome = dialect.readOnlyGuard(args.sql);
      if (outcome.verdict === "refuse") {
        throw fail("write_not_permitted", outcome.reason, outcome.recovery);
      }
      await requirePermittedPrincipal(signal);
      const result = await runner.run(
        {
          sql: outcome.statement,
          parameters: [],
          timeoutMs: args.timeoutMs ?? limits.queryTimeoutMs,
          maxRows: args.maxRows ?? limits.defaultRows,
        },
        signal,
      );
      return json(assemble(result));
    }),
  };
}

/**
 * Guard: the statement guard is advisory, so this is where read-only is made
 * true. An administrator escapes every transaction mode; a writable principal is
 * contained only where the session itself is read-only; an unverified one is
 * treated as the worst case.
 */
export function queryPermitted(
  posture: PrincipalPosture | "unknown",
  sessionIntent: "read_only" | "none",
): boolean {
  return (
    posture === "read_only" ||
    (posture === "writable" && sessionIntent === "read_only")
  );
}
