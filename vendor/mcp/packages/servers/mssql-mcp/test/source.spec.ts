import type mssql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { sqlText } from "@sezzlee/db-core";
import { createMssqlSource } from "../src/server.js";
import type { MssqlConfig } from "../src/platform/env.js";

const config: MssqlConfig = {
  server: "sql.example.com",
  port: 1433,
  database: "Sales",
  user: "reporting",
  password: "test-password",
  encrypt: true,
  trustServerCertificate: false,
  connectTimeoutMs: 1000,
  queryTimeoutMs: 1000,
};
const query = {
  sql: sqlText("select 1"),
  parameters: [],
  timeoutMs: 1000,
  maxRows: 2,
};

function recordingDriver(failing: string) {
  const issued: string[] = [];
  const closed: number[] = [];
  let opened = 0;
  const ConnectionPool = vi.fn(function () {
    opened += 1;
    const id = opened;
    const pool = {
      connect: async () => pool,
      close: async () => {
        closed.push(id);
      },
      request: () => {
        const handlers = new Map<string, (value?: unknown) => void>();
        const send = (sql: string) => {
          issued.push(sql);
          queueMicrotask(() => {
            if (sql === failing)
              handlers.get("error")?.(
                Object.assign(new Error("Divide by zero error encountered."), {
                  code: "EREQUEST",
                  number: 8134,
                }),
              );
            handlers.get("done")?.();
          });
        };
        const request = {
          stream: false,
          arrayRowMode: false,
          input: () => request,
          cancel: () => undefined,
          on: (event: string, handler: (value?: unknown) => void) => {
            handlers.set(event, handler);
            return request;
          },
          batch: send,
          query: send,
        };
        return request;
      },
    };
    return pool;
  });
  return {
    driver: { ConnectionPool } as unknown as typeof mssql,
    issued,
    closed,
    opened: () => opened,
  };
}

describe("SQL Server source", () => {
  it("runs each query inside a transaction it always rolls back, and closes the connection a failed one used", async () => {
    const recording = recordingDriver("select broken");
    const source = createMssqlSource(config, { driver: recording.driver });

    await source.runner.run(query);
    expect(recording.issued.slice(-3)).toEqual([
      "begin transaction",
      "select 1",
      "if @@trancount > 0 rollback transaction",
    ]);

    await expect(
      source.runner.run({ ...query, sql: sqlText("select broken") }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(recording.issued.slice(-2)).toEqual([
      "begin transaction",
      "select broken",
    ]);
    expect(recording.closed).toEqual([1]);

    await source.runner.run(query);
    expect(recording.opened()).toBe(2);
    expect(recording.issued.slice(-3)).toEqual([
      "begin transaction",
      "select 1",
      "if @@trancount > 0 rollback transaction",
    ]);
    await source.close();
  });
});
