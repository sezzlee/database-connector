import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import pg from "pg";
import Cursor from "pg-cursor";
import {
  columnDescriptor,
  type DriverAdapter,
  type DriverConnection,
  type QueryResult,
  type QuerySpec,
  type RunningQuery,
} from "@sezzlee/db-core";
import type { PostgresConfig } from "../platform/env.js";
import { describeType, nativeTypes } from "../dialect/types.js";

export interface PostgresField {
  readonly name: string;
  readonly dataTypeID: number;
  readonly dataTypeModifier?: number;
}
export interface PostgresCursor {
  read(
    size: number,
    callback: (
      error: Error | undefined,
      rows: unknown[][],
      result: { readonly fields: readonly PostgresField[] },
    ) => void,
  ): void;
  close(): Promise<void>;
}
export interface PostgresClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(cursor: PostgresCursor): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export interface PostgresDriverOptions {
  readonly host?: string;
  readonly serverName?: string;
  readonly clientFactory?: (config: pg.ClientConfig) => PostgresClient;
  readonly cursorFactory?: (
    sql: string,
    values: unknown[],
    options: Cursor.CursorQueryConfig,
  ) => PostgresCursor;
}

/** Guard: pg's default parsers turn these into JS numbers, dates or `JSON.parse` output, which silently rounds integers past 2^53 inside json and jsonb as well as in int8 and numeric. */
const intactTypes = new Set([
  20, 114, 1082, 1083, 1114, 1184, 1266, 1700, 3802,
]);
const parserTypes: pg.CustomTypesConfig = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    intactTypes.has(oid) && format !== "binary"
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format),
};
const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
/** Guard: pg reports a server that refuses the TLS request as a bare Error with no code, which callers can only misread as a certificate failure. */
const tlsRefused = (error: unknown) =>
  error instanceof Error &&
  !("code" in error) &&
  error.message === "The server does not support SSL connections"
    ? Object.assign(error, { code: "PG_TLS_UNSUPPORTED" })
    : error;

function clientConfig(
  config: PostgresConfig,
  options: PostgresDriverOptions,
): pg.ClientConfig {
  const hostname = options.serverName ?? config.server;
  return {
    host: options.host ?? config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: config.connectTimeoutMs,
    ssl:
      config.sslMode === "disable"
        ? false
        : {
            rejectUnauthorized: config.sslMode === "verify-full",
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
            ...(config.caCertificate === undefined
              ? {}
              : { ca: config.caCertificate }),
            ...(config.sslMode === "verify-full"
              ? {
                  checkServerIdentity: (_host, certificate) =>
                    checkServerIdentity(hostname, certificate),
                }
              : {}),
          },
  };
}

function describe(fields: readonly PostgresField[]) {
  return fields.map((field, ordinal) => {
    const typeName = nativeTypes[field.dataTypeID] ?? `oid:${field.dataTypeID}`;
    const modifier = field.dataTypeModifier ?? -1;
    const numeric = field.dataTypeID === 1700 && modifier >= 4;
    return columnDescriptor(
      field.name,
      ordinal,
      true,
      typeName,
      describeType({
        typeName,
        ...(numeric
          ? {
              precision: ((modifier - 4) >>> 16) & 65535,
              scale: (((modifier - 4) & 2047) ^ 1024) - 1024,
            }
          : {}),
        ...([1042, 1043].includes(field.dataTypeID) && modifier >= 4
          ? { maxLength: modifier - 4 }
          : {}),
      }),
    );
  });
}

export function createPostgresDriver(
  options: PostgresDriverOptions = {},
): DriverAdapter<PostgresConfig> {
  let nextId = 0;
  return {
    isBroken: (error) => {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        typeof error.code !== "string"
      )
        return false;
      return (
        error.code.startsWith("08") ||
        [
          "ECANCEL",
          "ETIMEOUT",
          "PG_CONNECTION_CLOSED",
          "ECONNRESET",
          "EPIPE",
          "57P01",
          "57P02",
          "57P03",
        ].includes(error.code)
      );
    },
    async open(config, signal): Promise<DriverConnection> {
      const client =
        options.clientFactory?.(clientConfig(config, options)) ??
        (new pg.Client(
          clientConfig(config, options),
        ) as unknown as PostgresClient);
      let destroyed = false;
      let closing: Promise<void> | undefined;
      const destroy = (): Promise<void> => {
        destroyed = true;
        closing ??= client.end();
        return closing;
      };
      client.on("error", () => {
        destroyed = true;
      });
      const aborted = () => {
        void destroy().catch(() => {});
      };
      if (signal?.aborted) {
        await destroy();
        throw failure("ECANCEL", "The connection was cancelled.");
      }
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        await client.connect();
        if (signal?.aborted || destroyed) {
          await destroy();
          throw failure("ECANCEL", "The connection was cancelled.");
        }
      } catch (error) {
        await destroy().catch(() => {});
        throw signal?.aborted
          ? failure("ECANCEL", "The connection was cancelled.")
          : tlsRefused(error);
      } finally {
        signal?.removeEventListener("abort", aborted);
      }
      return {
        id: ++nextId,
        destroy,
        run(spec: QuerySpec): RunningQuery {
          if (destroyed)
            return {
              settled: Promise.reject(
                failure(
                  "PG_CONNECTION_CLOSED",
                  "The PostgreSQL connection is closed.",
                ),
              ),
              cancel: () => {},
            };
          const cursor =
            options.cursorFactory?.(
              spec.sql,
              spec.parameters.map((parameter) => parameter.value),
              { rowMode: "array", types: parserTypes },
            ) ??
            new Cursor<unknown[]>(
              spec.sql,
              spec.parameters.map((parameter) => parameter.value),
              { rowMode: "array", types: parserTypes },
            );
          let stopped = false;
          let done = false;
          let resolve!: (result: QueryResult) => void;
          let reject!: (error: unknown) => void;
          const settled = new Promise<QueryResult>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          const rows: unknown[][] = [];
          let columns: QueryResult["columns"] = [];
          const finish = (error?: unknown, more = false) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error !== undefined) reject(error);
            else resolve({ rows, columns, more });
          };
          const stop = (code: string) => {
            if (done || stopped) return;
            stopped = true;
            void destroy().then(
              () =>
                finish(
                  failure(
                    code,
                    code === "ETIMEOUT"
                      ? "The PostgreSQL query deadline expired."
                      : "The PostgreSQL query was cancelled.",
                  ),
                ),
              () =>
                finish(failure(code, "The PostgreSQL connection was closed.")),
            );
          };
          const timer = setTimeout(() => stop("ETIMEOUT"), spec.timeoutMs);
          const close = (more: boolean) => {
            void cursor.close().then(
              () => {
                if (!stopped) finish(undefined, more);
              },
              () => stop("PG_CONNECTION_CLOSED"),
            );
          };
          const read = () => {
            try {
              /** Guard: a cursor retains only the requested batch; one lookahead row proves truncation without buffering the complete result. */
              const count = Math.min(
                128,
                Math.max(1, spec.maxRows + 1 - rows.length),
              );
              cursor.read(count, (error, batch, result) => {
                if (done || stopped) return;
                if (error) {
                  /** Guard: pg reports active cursor failure before its socket error event; defer classification until that event marks the physical connection closed. */
                  queueMicrotask(() => {
                    if (!stopped)
                      finish(
                        destroyed
                          ? failure(
                              "PG_CONNECTION_CLOSED",
                              "The PostgreSQL connection is closed.",
                            )
                          : error,
                      );
                  });
                  return;
                }
                columns = describe(result.fields);
                const room = Math.max(0, spec.maxRows - rows.length);
                rows.push(...batch.slice(0, room));
                if (batch.length > room) {
                  close(true);
                  return;
                }
                if (batch.length < count) {
                  close(false);
                  return;
                }
                read();
              });
            } catch (error) {
              finish(error);
            }
          };
          try {
            client.query(cursor);
            read();
          } catch (error) {
            finish(error);
          }
          return { settled, cancel: () => stop("ECANCEL") };
        },
      };
    },
  };
}
