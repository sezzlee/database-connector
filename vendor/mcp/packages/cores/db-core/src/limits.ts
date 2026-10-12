import { mcpCoreLimits } from "@sezzlee/mcp-core";

export const dbCoreLimits = {
  ...mcpCoreLimits,
  maxRows: 1_000,
  defaultRows: 100,
  maxColumns: 512,
  maxKeys: 256,
  maxTextChars: 4_096,
  maxBinaryBytes: 4_096,
  maxListResults: 200,
  maxIndexObjects: 5_000,
  maxIndexRows: 50_000,
  maxDescriptionChars: 160,
  /**
   * Guard: the catalogue read is the cost of an index, not the index itself.
   * Measured on a 614-object, 11 518-column catalogue: about 0.5 s to read and
   * build, 1 ms from the cached index, about 300 KB of postings. Without a TTL
   * every search pays the read; without expiry a schema change is never seen.
   */
  catalogIndexTtlMs: 15 * 60_000,
  maxQueryTerms: 16,
  maxExpansions: 32,
  maxMatchReasons: 8,
  defaultListResults: 50,
  queryTimeoutMs: 30_000,
  maxConnections: 4,
  maxQueueDepth: 32,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 60_000,
  /**
   * Guard: how long a cancelled request may take to settle before its
   * connection is destroyed instead of returned to the pool. A cancel that
   * never settles then costs one connection, never a crossed result set.
   * Measured on the first dialect's driver, a 20 s statement cancelled at
   * 700 ms settled at 714 ms and the same connection ran the next query, so
   * this ceiling is the rare path, not the normal one.
   */
  cancelSettleMs: 5_000,
} as const;

/**
 * Guard: widened to `number`, not `typeof dbCoreLimits`. The literal type made
 * every field assignable only to the value it already had, so a product could
 * name an override but never actually change one — and a test could not narrow
 * a limit to reach the path that limit guards.
 */
export type DbLimits = Readonly<Record<keyof typeof dbCoreLimits, number>>;
