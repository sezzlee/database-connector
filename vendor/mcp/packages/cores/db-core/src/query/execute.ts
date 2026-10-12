import { McpSourceError, type ErrorFactory } from "@sezzlee/mcp-core";
import type { DbErrorCode } from "../errors.js";
import type {
  ConnectionPool,
  DriverAdapter,
  PoolLimits,
} from "../model/connection.js";
import type { Dialect } from "../model/dialect.js";
import type { QueryResult, QuerySpec } from "../model/sql.js";
import { runCancellable } from "../pool/cancel.js";

export interface QueryRunner {
  run(spec: QuerySpec, signal?: AbortSignal): Promise<QueryResult>;
}

export interface QueryRunnerSpec<TConfig> {
  readonly pool: ConnectionPool;
  readonly dialect: Dialect<TConfig>;
  readonly driver: DriverAdapter<TConfig>;
  readonly limits: PoolLimits;
  readonly fail: ErrorFactory<DbErrorCode>;
}

export function createQueryRunner<TConfig>(
  spec: QueryRunnerSpec<TConfig>,
): QueryRunner {
  const { pool, dialect, driver, limits, fail } = spec;
  return {
    async run(query: QuerySpec, signal?: AbortSignal): Promise<QueryResult> {
      /**
       * Guard: opening a connection is where a wrong host or a refused login
       * surfaces, so the pool's failure goes through the same classification as
       * a query's. Left unclassified, it reached the agent as internal_error,
       * which says "a defect in the server" about a mistyped address.
       */
      const lease = await pool.acquire(signal).catch((error: unknown) => {
        throw classify(error, dialect, fail);
      });
      const scope = dialect.queryScope(query);
      const run = (spec: QuerySpec) =>
        runCancellable(lease, spec, signal, limits, fail, (error) =>
          driver.isBroken(error),
        );
      try {
        if (scope.kind === "session") return await run(query);
        for (const statement of scope.begin) await run(statement);
        const result = await run(query);
        for (const statement of scope.commit) await run(statement);
        return result;
      } catch (error) {
        /**
         * Guard: a connection the driver calls broken must not go back to the
         * pool. `runCancellable` already quarantines the cancellation case; this
         * covers a protocol or socket failure, where reuse would surface as an
         * unrelated error on someone else's call. A failed transaction scope is
         * quarantined too: the session may still hold the aborted transaction or
         * state the statement set, and closing it is the only reset that does not
         * depend on reaching the same backend through a transaction pooler.
         */
        if (scope.kind === "transaction" || driver.isBroken(error)) {
          lease.quarantine();
        }
        throw classify(error, dialect, fail);
      } finally {
        lease.release();
      }
    },
  };
}

function classify<TConfig>(
  error: unknown,
  dialect: Dialect<TConfig>,
  fail: ErrorFactory<DbErrorCode>,
): unknown {
  if (error instanceof McpSourceError) {
    return error;
  }
  const mapped = dialect.mapDriverError(error);
  if (mapped === undefined) {
    return error;
  }
  const detail =
    mapped.engineCode === undefined
      ? mapped.message
      : `${mapped.message} (${String(mapped.engineCode)})`;
  return fail(mapped.code, detail, mapped.recovery);
}
