import {
  sqlText,
  type Dialect,
  type QueryScope,
  type QuerySpec,
} from "@sezzlee/db-core";
import type { PostgresConfig } from "../platform/env.js";
import { secretPatterns } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { mapDriverError } from "./errors.js";
import { readOnlyGuard } from "./guard.js";
import { createIntrospection } from "./introspect.js";
import { quoteIdentifier, quoteQualified } from "./quote.js";
import { describeType } from "./types.js";

const statement = (
  sql: string,
  timeoutMs: number,
  parameters: QuerySpec["parameters"] = [],
): QuerySpec => ({ sql: sqlText(sql), parameters, timeoutMs, maxRows: 1 });

/**
 * Guard: the transaction is read only, so a statement cannot switch it to
 * read-write after its snapshot is taken, and it always ends in ROLLBACK, even
 * when the query succeeded: a session-level `set_config(..., false)` the
 * statement made is undone with it instead of committing into the session, and
 * a NOTIFY it queued is never sent. Session advisory locks survive a rollback,
 * so they are released first, on the same backend.
 */
const queryScope = (spec: QuerySpec): QueryScope => ({
  kind: "transaction",
  begin: [
    statement("start transaction read only", spec.timeoutMs),
    statement(
      "select pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $1, true), pg_catalog.set_config('search_path', 'pg_catalog', true), pg_catalog.set_config('standard_conforming_strings', 'on', true)",
      spec.timeoutMs,
      [{ name: "timeout", value: String(spec.timeoutMs) }],
    ),
  ],
  commit: [
    statement("select pg_catalog.pg_advisory_unlock_all()", spec.timeoutMs),
    statement("rollback", spec.timeoutMs),
  ],
});

export function createPostgresDialect(timeoutMs: number) {
  return {
    id: "postgres",
    secretPatterns,
    sessionSetup: () => [],
    sessionIntent: () => "read_only" as const,
    queryScope,
    quoteIdentifier,
    quoteQualified,
    describeType,
    introspection: createIntrospection(timeoutMs, {
      maxColumns: limits.maxColumns,
      maxKeys: limits.maxKeys,
    }),
    mapDriverError,
    readOnlyGuard,
  } as const satisfies Dialect<PostgresConfig>;
}
export const postgresDialect = createPostgresDialect(limits.queryTimeoutMs);
