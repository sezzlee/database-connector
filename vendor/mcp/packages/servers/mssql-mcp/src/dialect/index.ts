import {
  sqlText,
  type Dialect,
  type QueryScope,
  type QuerySpec,
} from "@sezzlee/db-core";
import type { MssqlConfig } from "../platform/env.js";
import { secretPatterns } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { mapDriverError } from "./errors.js";
import { readOnlyGuard } from "./guard.js";
import { createIntrospection } from "./introspect.js";
import { quoteIdentifier, quoteQualified } from "./quote.js";
import { describeType } from "./types.js";

/**
 * Guard: `lock_timeout` is what stops a read from waiting behind a writer
 * forever — a reporting connection has no business holding a call open until the
 * server gives up. `nocount` keeps row-count chatter out of the result stream.
 * Neither changes what a statement reads.
 */
const sessionStatements = (timeoutMs: number): readonly QuerySpec[] => [
  {
    sql: sqlText(`set nocount on; set lock_timeout ${timeoutMs};`),
    parameters: [],
    timeoutMs,
    maxRows: 0,
  },
];

/**
 * Guard: MSSQL has no read-only transaction, so every query runs inside one
 * that is always rolled back. A write the statement guard missed is undone in
 * this database; effects outside the transaction (sequence and identity
 * values, remote calls) are not, which is why the principal check still
 * refuses a writable principal. The guard refuses COMMIT, ROLLBACK, SAVE and
 * BEGIN, so the statement cannot end the transaction itself.
 */
const queryScope = (spec: QuerySpec): QueryScope => ({
  kind: "transaction",
  begin: [
    {
      sql: sqlText("begin transaction"),
      parameters: [],
      timeoutMs: spec.timeoutMs,
      maxRows: 0,
    },
  ],
  commit: [
    {
      sql: sqlText("if @@trancount > 0 rollback transaction"),
      parameters: [],
      timeoutMs: spec.timeoutMs,
      maxRows: 0,
    },
  ],
});

/**
 * Builds the dialect for one connection's query deadline.
 *
 * @param queryTimeoutMs the deadline the session's `lock_timeout` and the catalogue queries run under
 */
export function createMssqlDialect(queryTimeoutMs: number) {
  return {
    id: "mssql",
    secretPatterns,
    sessionSetup: () => sessionStatements(queryTimeoutMs),
    /**
     * Guard: MSSQL has no equivalent of a read-only session default.
     * `ApplicationIntent=ReadOnly` only routes to a readable secondary inside an
     * availability group and guarantees nothing on a standalone instance, so
     * claiming one here would be a lie the agent cannot check. The guarantee is
     * the database principal.
     */
    sessionIntent: () => "none" as const,
    queryScope,
    quoteIdentifier,
    quoteQualified,
    describeType,
    introspection: createIntrospection(queryTimeoutMs, {
      maxColumns: limits.maxColumns,
      maxKeys: limits.maxKeys,
    }),
    mapDriverError,
    readOnlyGuard,
  } as const satisfies Dialect<MssqlConfig>;
}

export const mssqlDialect = createMssqlDialect(limits.queryTimeoutMs);
