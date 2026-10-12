import { McpSourceError, type ErrorFactory } from "@sezzlee/mcp-core";
import { introspectOne } from "./catalog/introspect.js";
import { createCatalogCache, type CatalogCache } from "./catalog/snapshot.js";
import type { DbErrorCode } from "./errors.js";
import { dbCoreLimits, type DbLimits } from "./limits.js";
import type {
  ConnectionPool,
  ConnectionProfile,
  DriverAdapter,
} from "./model/connection.js";
import type { Dialect, PrincipalPosture } from "./model/dialect.js";
import { baseSecretPatterns, redactSecrets } from "./primitives/redact.js";
import { createConnectionPool } from "./pool/pool.js";
import { createQueryRunner, type QueryRunner } from "./query/execute.js";
import type { DbVocabulary } from "./vocabulary.js";

const principalTtlMs = 300_000;
const unmeasurable: ReadonlySet<string> = new Set([
  "query_failed",
  "permission_denied",
  "object_not_found",
]);

export interface DbEnvironment<TConfig> {
  readonly dialect: Dialect<TConfig>;
  readonly vocabulary: DbVocabulary<string>;
  readonly fail: ErrorFactory<DbErrorCode>;
  readonly limits?: DbLimits;
}

export interface DbSource<TConfig> {
  readonly dialect: Dialect<TConfig>;
  readonly vocabulary: DbVocabulary<string>;
  readonly fail: ErrorFactory<DbErrorCode>;
  readonly limits: DbLimits;
  readonly profile: ConnectionProfile<TConfig>;
  /** What the connection-level read-only posture actually guarantees. */
  readonly sessionIntent: "read_only" | "none";
  principal(signal?: AbortSignal): Promise<PrincipalPosture | "unknown">;
  readonly pool: ConnectionPool;
  readonly runner: QueryRunner;
  /** The catalogue snapshot every search is answered from. */
  readonly catalog: CatalogCache;
  /** Strips connection secrets from any string bound for a tool response. */
  readonly redact: (detail: string) => string;
  close(): Promise<void>;
}

/**
 * Binds one dialect, one connection profile and one driver adapter into the
 * object every tool handler reaches the database through.
 *
 * Guard: the redactor is assembled here, from the core's patterns plus the
 * dialect's, so a server cannot be composed without one. It is the seam
 * `@sezzlee/mcp-core` leaves open through `ErrorContext.redact`.
 */
export function createDbSource<TConfig>(
  environment: DbEnvironment<TConfig>,
  profile: ConnectionProfile<TConfig>,
  driver: DriverAdapter<TConfig>,
): DbSource<TConfig> {
  const limits = environment.limits ?? dbCoreLimits;
  const { dialect, vocabulary, fail } = environment;
  const config = profile.secret.reveal();
  const patterns = [...baseSecretPatterns, ...dialect.secretPatterns];

  const pool = createConnectionPool({
    driver,
    config,
    limits,
    fail,
    sessionSetup: dialect.sessionSetup(config),
  });

  const runner = createQueryRunner({ pool, dialect, driver, limits, fail });
  const catalog = createCatalogCache({
    runner,
    dialect,
    limits,
    fail,
    vocabulary,
  });

  /**
   * Guard: a measured posture is reused for a bounded time only, so a grant
   * added after the first query reaches `run_query` within that window instead
   * of never. Only a failure of the measuring statement itself reads as
   * `unknown` and is not cached; a connection, login or cancellation failure is
   * rethrown so the caller reports that cause instead of a privilege refusal.
   */
  let measured:
    { readonly posture: PrincipalPosture; readonly at: number } | undefined;
  const principal = async (
    signal?: AbortSignal,
  ): Promise<PrincipalPosture | "unknown"> => {
    if (measured !== undefined && Date.now() - measured.at < principalTtlMs)
      return measured.posture;
    const posture = await introspectOne(
      runner,
      dialect.introspection.principal(),
      signal,
    ).catch((error: unknown) => {
      if (
        error instanceof McpSourceError &&
        unmeasurable.has(error.code) &&
        signal?.aborted !== true
      )
        return undefined;
      throw error;
    });
    if (posture === undefined) return "unknown";
    measured = { posture, at: Date.now() };
    return posture;
  };

  return {
    dialect,
    vocabulary,
    fail,
    limits,
    profile,
    sessionIntent: dialect.sessionIntent(config),
    principal,
    pool,
    runner,
    catalog,
    redact: (detail) => redactSecrets(detail, patterns),
    close: async () => {
      catalog.clear();
      await pool.close();
    },
  };
}
