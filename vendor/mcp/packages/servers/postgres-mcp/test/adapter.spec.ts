import { describe, expect, it, vi } from "vitest";
import { sqlText } from "@sezzlee/db-core";
import {
  createPostgresDriver,
  type PostgresClient,
  type PostgresCursor,
} from "../src/driver/adapter.js";
import type { PostgresConfig } from "../src/platform/env.js";
import type { ClientConfig } from "pg";

const config: PostgresConfig = {
  server: "db.example",
  port: 5432,
  database: "data",
  user: "reader",
  password: "secret",
  sslMode: "verify-full",
  connectTimeoutMs: 1000,
  queryTimeoutMs: 1000,
};

function fixture(values: unknown[][] = [[1], [2], [3]]) {
  const events: string[] = [];
  let offset = 0;
  const client: PostgresClient = {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {
      events.push("end");
    }),
    query: vi.fn(() => {}),
    on: vi.fn(),
  };
  const cursor: PostgresCursor = {
    read: vi.fn((size, callback) => {
      events.push(`read:${size}`);
      const rows = values.slice(offset, offset + size);
      offset += rows.length;
      callback(undefined, rows, {
        fields: [{ name: "n", dataTypeID: 23, dataTypeModifier: -1 }],
      });
    }),
    close: vi.fn(async () => {
      events.push("close");
    }),
  };
  const clientFactory = vi.fn((_config: ClientConfig) => client);
  const cursorFactory = vi.fn(() => cursor);
  return { client, cursor, events, clientFactory, cursorFactory };
}

describe("PostgreSQL adapter", () => {
  it("marks uncoded socket termination as broken before returning the native query error", async () => {
    const fake = fixture();
    let onError: ((error: Error) => void) | undefined;
    fake.client.on = (_event, listener) => {
      onError = listener;
    };
    fake.cursor.read = (_size, callback) => {
      const error = new Error("Connection terminated unexpectedly");
      callback(error, [], { fields: [] });
      onError?.(error);
    };
    const driver = createPostgresDriver(fake);
    const opened = await driver.open(config);
    const error = await opened
      .run({
        sql: sqlText("select 1"),
        parameters: [],
        timeoutMs: 1000,
        maxRows: 5,
      })
      .settled.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "PG_CONNECTION_CLOSED" });
    expect(driver.isBroken(error)).toBe(true);
  });
  it("pins dial host and verifies original DNS hostname", async () => {
    const fake = fixture();
    const driver = createPostgresDriver({
      ...fake,
      host: "203.0.113.20",
      serverName: "db.example",
    });
    await driver.open(config);
    const passed = fake.clientFactory.mock.calls[0]?.[0] as unknown as {
      host: string;
      ssl: {
        servername: string;
        rejectUnauthorized: boolean;
        checkServerIdentity: (host: string, cert: object) => Error | undefined;
      };
    };
    expect(passed.host).toBe("203.0.113.20");
    expect(passed.ssl.servername).toBe("db.example");
    expect(passed.ssl.rejectUnauthorized).toBe(true);
    expect(
      passed.ssl.checkServerIdentity("203.0.113.20", {
        subjectaltname: "DNS:attacker.example",
      }),
    ).toBeInstanceOf(Error);
  });
  it("omits SNI for an IP while verifying the original IP certificate", async () => {
    const fake = fixture();
    await createPostgresDriver({ ...fake, serverName: "192.0.2.1" }).open(
      config,
    );
    const passed = fake.clientFactory.mock.calls[0]?.[0] as unknown as {
      ssl: {
        servername?: string;
        checkServerIdentity: (host: string, cert: object) => Error | undefined;
      };
    };
    expect(passed.ssl.servername).toBeUndefined();
    expect(
      passed.ssl.checkServerIdentity("db.example", {
        subjectaltname: "IP Address:192.0.2.1",
      }),
    ).toBeUndefined();
  });
  it("caps rows before retaining more, closes portal, then reuses connection", async () => {
    const fake = fixture();
    const connection = await createPostgresDriver(fake).open(config);
    const spec = {
      sql: sqlText("select n from public.t"),
      parameters: [],
      timeoutMs: 1000,
      maxRows: 2,
    };
    const result = await connection.run(spec).settled;
    expect(result).toMatchObject({ rows: [[1], [2]], more: true });
    expect(fake.events).toEqual(["read:3", "close"]);
    await connection.run(spec).settled;
    expect(fake.client.end).not.toHaveBeenCalled();
    expect(fake.client.query).toHaveBeenCalledTimes(2);
  });
  it("reads large results in batches no larger than 128", async () => {
    const fake = fixture(Array.from({ length: 1000 }, (_, n) => [n]));
    const connection = await createPostgresDriver(fake).open(config);
    const result = await connection.run({
      sql: sqlText("select n from public.t"),
      parameters: [],
      timeoutMs: 1000,
      maxRows: 300,
    }).settled;
    expect(result.rows).toHaveLength(300);
    expect(fake.events).toEqual(["read:128", "read:128", "read:45", "close"]);
  });
  it("cancel settles after physical close and marks error broken", async () => {
    const fake = fixture();
    fake.cursor.read = vi.fn(() => {});
    const driver = createPostgresDriver(fake);
    const connection = await driver.open(config);
    const query = connection.run({
      sql: sqlText("select 1"),
      parameters: [],
      timeoutMs: 1000,
      maxRows: 5,
    });
    query.cancel();
    const error = await query.settled.catch((reason: unknown) => reason);
    expect(fake.events).toEqual(["end"]);
    expect(driver.isBroken(error)).toBe(true);
    expect(error).toMatchObject({ code: "ECANCEL" });
    await expect(
      connection.run({
        sql: sqlText("select 1"),
        parameters: [],
        timeoutMs: 1000,
        maxRows: 5,
      }).settled,
    ).rejects.toMatchObject({ code: "PG_CONNECTION_CLOSED" });
  });
  it("deadline interrupts stalled cursor and closes socket", async () => {
    const fake = fixture();
    fake.cursor.read = vi.fn(() => {});
    const connection = await createPostgresDriver(fake).open(config);
    await expect(
      connection.run({
        sql: sqlText("select 1"),
        parameters: [],
        timeoutMs: 5,
        maxRows: 5,
      }).settled,
    ).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(fake.events).toEqual(["end"]);
  });
});
