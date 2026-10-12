import type { QueryResult, QuerySpec } from "./sql.js";

declare const secretBrand: unique symbol;

/**
 * A parsed, dialect-shaped connection configuration.
 *
 * Guard: `reveal()` is a method rather than a field, so `JSON.stringify` of
 * anything holding one yields `{}` for the secret and every read site is
 * greppable. Opaque to db-core: it is never serialised, never logged and never
 * reaches a tool response.
 */
export interface ConnectionSecret<TConfig> {
  readonly [secretBrand]: true;
  reveal(): TConfig;
  toJSON(): undefined;
}

export function connectionSecret<TConfig>(
  config: TConfig,
): ConnectionSecret<TConfig> {
  /**
   * Guard: the brand is a declared type, not a runtime value, so it must not be
   * written as a key here — doing so throws `secretBrand is not defined` on the
   * first call while still type-checking.
   */
  return {
    reveal: () => config,
    toJSON: () => undefined,
  } as unknown as ConnectionSecret<TConfig>;
}

/** Non-secret facts that are safe to echo to an agent. */
export interface ConnectionDisplay {
  readonly alias: string;
  readonly engine: string;
  readonly catalog?: string;
  readonly principal?: string;
}

export interface ConnectionProfile<TConfig> {
  /** The alias an agent may name. Never a connection string. */
  readonly alias: string;
  readonly secret: ConnectionSecret<TConfig>;
  readonly display: ConnectionDisplay;
}

/** A query in flight. `cancel()` is best effort; `settled` always settles. */
export interface RunningQuery {
  readonly settled: Promise<QueryResult>;
  cancel(): void;
}

export interface DriverConnection {
  readonly id: number;
  run(spec: QuerySpec): RunningQuery;
  /** Physically closes the socket. Called for a quarantined connection. */
  destroy(): Promise<void>;
}

/** The product's driver layer implements exactly this, and nothing else. */
export interface DriverAdapter<TConfig> {
  open(config: TConfig, signal?: AbortSignal): Promise<DriverConnection>;
  /** True when the connection must not be reused after this error. */
  isBroken(error: unknown): boolean;
}

export interface PoolLimits {
  readonly maxConnections: number;
  readonly maxQueueDepth: number;
  readonly connectTimeoutMs: number;
  readonly cancelSettleMs: number;
}

export interface Lease {
  readonly connection: DriverConnection;
  readonly generation: number;
  release(): void;
  /** Marks the connection unfit for reuse; `release()` then destroys it. */
  quarantine(): void;
}

export interface ConnectionPool {
  readonly generation: number;
  acquire(signal?: AbortSignal): Promise<Lease>;
  close(): Promise<void>;
}
