import mssql from "mssql";
import {
  columnDescriptor,
  type ColumnDescriptor,
  type DriverAdapter,
  type DriverConnection,
  type QueryResult,
  type QuerySpec,
  type RunningQuery,
} from "@sezzlee/db-core";
import type { MssqlConfig } from "../platform/env.js";
import type { LookupFunction } from "node:net";
import type { Socket } from "node:net";
import { describeType } from "../dialect/types.js";

type Driver = typeof mssql;

interface ColumnMeta {
  readonly name: string;
  readonly index: number;
  readonly nullable?: boolean;
  readonly length?: number;
  readonly scale?: number;
  readonly precision?: number;
  readonly type?: { readonly name?: string };
}

type Stop = "maxRows" | "deadline" | "caller";

function poolConfig(
  config: MssqlConfig,
  deps: MssqlDriverDeps,
  openingSignal?: AbortSignal,
): mssql.config {
  // @types/mssql declares a zero-argument hook; Tedious passes socket options,
  // DNS lookup and cancellation. Optional parameters cover both contracts.
  const connector =
    deps.connector === undefined
      ? undefined
      : async (
          options?: {
            readonly host: string;
            readonly port: number;
            readonly localAddress?: string;
          },
          lookup?: LookupFunction,
          signal?: AbortSignal,
        ): Promise<Socket> => {
          if (
            options === undefined ||
            lookup === undefined ||
            deps.connector === undefined
          )
            throw new Error("Invalid database socket context");
          const combined =
            openingSignal === undefined
              ? signal
              : signal === undefined
                ? openingSignal
                : AbortSignal.any([openingSignal, signal]);
          return deps.connector(options, lookup, combined);
        };
  return {
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: config.connectTimeoutMs,
    requestTimeout: config.queryTimeoutMs,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      ...(connector === undefined ? {} : { connector }),
      ...(deps.serverName === undefined ? {} : { serverName: deps.serverName }),
    },
    /**
     * Guard: one physical connection per pool. db-core owns the pooling, and
     * nesting a second pool underneath it would let two calls share a socket
     * behind its back — which is exactly what the cancellation rule depends on
     * not happening.
     */
    pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
  };
}

/**
 * Guard: the result-set path and the catalogue path both build their columns
 * through `columnDescriptor` over the dialect's verdict. Forwarding each
 * source's own fields instead is what let `run_query` and `describe_table`
 * report opposite fidelity for the same column. The driver's `type.id` arrives
 * undefined, so `type.name` is the only key.
 */
function describe(meta: readonly ColumnMeta[]): ColumnDescriptor[] {
  return meta.map((column) =>
    columnDescriptor(
      column.name,
      column.index,
      column.nullable !== false,
      column.type?.name ?? "unknown",
      describeType({
        typeName: column.type?.name ?? "unknown",
        ...(column.length === undefined ? {} : { maxLength: column.length }),
        ...(column.precision === undefined
          ? {}
          : { precision: column.precision }),
        ...(column.scale === undefined ? {} : { scale: column.scale }),
      }),
    ),
  );
}

function bind(request: mssql.Request, spec: QuerySpec): void {
  for (const parameter of spec.parameters) {
    request.input(parameter.name, parameter.value);
  }
}

function timeoutError(ms: number): Error {
  return Object.assign(new Error(`The query exceeded its ${ms} ms deadline.`), {
    code: "ETIMEOUT",
  });
}

function cancellationError(): Error {
  return Object.assign(new Error("The connection was cancelled."), {
    code: "ECANCEL",
  });
}

export interface MssqlDriverDeps {
  readonly driver?: Driver;
  /** Trusted host application hook; never read from SQL or the environment. */
  readonly connector?: (
    options: {
      readonly host: string;
      readonly port: number;
      readonly localAddress?: string;
    },
    lookup: LookupFunction,
    signal?: AbortSignal,
  ) => Promise<Socket>;
  readonly serverName?: string;
}

export function createMssqlDriver(
  deps: MssqlDriverDeps = {},
): DriverAdapter<MssqlConfig> {
  const driver = deps.driver ?? mssql;
  let nextId = 0;

  return {
    async open(
      config: MssqlConfig,
      signal?: AbortSignal,
    ): Promise<DriverConnection> {
      if (signal?.aborted) throw cancellationError();
      const connecting = new AbortController();
      const pool = new driver.ConnectionPool(
        poolConfig(config, deps, connecting.signal),
      );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          connecting.abort();
          reject(cancellationError());
          void pool.close().catch(() => undefined);
        };
        const dispose = () => signal?.removeEventListener("abort", abort);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          void pool.connect().then(
            () => {
              dispose();
              if (connecting.signal.aborted) {
                void pool.close().catch(() => undefined);
                reject(cancellationError());
                return;
              }
              resolve();
            },
            (error) => {
              dispose();
              reject(error);
            },
          );
        } catch (error) {
          dispose();
          reject(error);
        }
      });
      if (signal?.aborted) {
        void pool.close().catch(() => undefined);
        throw cancellationError();
      }
      nextId += 1;
      const id = nextId;
      return {
        id,
        destroy: async () => {
          await pool.close().catch(() => undefined);
        },
        run: (spec: QuerySpec): RunningQuery => {
          const request = pool.request();
          bind(request, spec);
          request.stream = true;
          request.arrayRowMode = true;

          let columns: ColumnDescriptor[] = [];
          const rows: (readonly unknown[])[] = [];
          let stop: Stop | undefined;
          let failure: unknown;
          let done = false;

          let settleWith: (result: QueryResult) => void = () => {};
          let failWith: (error: unknown) => void = () => {};
          const settled = new Promise<QueryResult>((resolve, reject) => {
            settleWith = resolve;
            failWith = reject;
          });

          /**
           * Guard: measured — `request.timeout` does not interrupt a running
           * statement, so the deadline has to be a timer that cancels. Without
           * it a blocked query holds its connection until the server releases
           * it, whatever the caller asked for.
           */
          const deadline = setTimeout(() => {
            if (!done) {
              stop = "deadline";
              request.cancel();
            }
          }, spec.timeoutMs);
          deadline.unref?.();

          const finish = (): void => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(deadline);
            if (stop === "deadline") {
              failWith(timeoutError(spec.timeoutMs));
              return;
            }
            if (stop === undefined && failure !== undefined) {
              failWith(failure);
              return;
            }
            settleWith({ columns, rows, more: stop === "maxRows" });
          };

          request.on("recordset", (meta: unknown) => {
            columns = describe(
              Array.isArray(meta) ? (meta as ColumnMeta[]) : [],
            );
          });
          request.on("row", (row: unknown) => {
            if (rows.length >= spec.maxRows) {
              if (stop === undefined) {
                stop = "maxRows";
                request.cancel();
              }
              return;
            }
            rows.push(Array.isArray(row) ? (row as unknown[]) : [row]);
          });
          /**
           * Guard: a cancel makes the driver emit `error` and then `done`. Only
           * `done` settles, so a cancel the caller asked for cannot resolve
           * before the request has actually finished on the wire.
           */
          request.on("error", (error: unknown) => {
            failure = error;
          });
          request.on("done", finish);

          /**
           * Guard: measured — `query()` always sends `sp_executesql`, and SQL
           * Server fails a remote call that returns with a different
           * transaction count (error 266) and restores the SET options it
           * changed. A statement without parameters goes as a plain batch, so
           * the query scope's BEGIN and ROLLBACK and the session SETs hold.
           */
          void (spec.parameters.length === 0
            ? request.batch(spec.sql)
            : request.query(spec.sql));

          return {
            settled,
            cancel: () => {
              if (!done) {
                stop ??= "caller";
                request.cancel();
              }
            },
          };
        },
      };
    },

    isBroken: (error: unknown): boolean => {
      const code = (error as { code?: unknown } | null)?.code;
      return (
        code === "ESOCKET" || code === "ECONNCLOSED" || code === "ENOTOPEN"
      );
    },
  };
}
