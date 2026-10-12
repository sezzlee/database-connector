import { Socket, type LookupFunction } from "node:net";
import type mssql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { createMssqlDriver } from "../src/driver/adapter.js";
import type { MssqlConfig } from "../src/platform/env.js";

const config: MssqlConfig = {
  server: "sql.example.com",
  port: 1433,
  database: "Sales",
  user: "reporting",
  password: "test-password",
  encrypt: true,
  trustServerCertificate: false,
  connectTimeoutMs: 15000,
  queryTimeoutMs: 30000,
};
const socketOptions = { host: config.server, port: config.port };
const lookup = vi.fn() as unknown as LookupFunction;

function fakeDriver() {
  let resolveLogin: () => void = () => undefined;
  const login = {
    promise: new Promise<void>((resolve) => {
      resolveLogin = resolve;
    }),
    resolve: () => resolveLogin(),
  };
  interface FakePool {
    config: mssql.config;
    close: () => Promise<void>;
    request: () => unknown;
    connect: () => Promise<FakePool>;
  }
  let instance: FakePool | undefined;
  const FakePool = vi.fn(function (config: mssql.config) {
    const pool: FakePool = {
      config,
      close: vi.fn(async () => {}),
      request: vi.fn(),
      connect: async () => {
        await login.promise;
        return pool;
      },
    };
    instance = pool;
    return pool;
  });
  return {
    driver: { ConnectionPool: FakePool } as unknown as typeof mssql,
    login,
    getPool: () => {
      if (instance === undefined) throw new Error("Pool was not constructed");
      return instance;
    },
    hasPool: () => instance !== undefined,
  };
}

type SocketConnector = (
  options: typeof socketOptions,
  lookup: LookupFunction,
  signal?: AbortSignal,
) => Promise<Socket>;
function connectorOf(
  pool: ReturnType<ReturnType<typeof fakeDriver>["getPool"]>,
): SocketConnector {
  return pool.config.options?.connector as unknown as SocketConnector;
}

describe("MSSQL connection cancellation", () => {
  it("rejects a cancelled pending SQL login before connect settles, then closes its late pool", async () => {
    const fake = fakeDriver();
    const controller = new AbortController();
    const opening = createMssqlDriver({ driver: fake.driver }).open(
      config,
      controller.signal,
    );
    let rejected = false;
    const observed = opening.catch((error) => {
      rejected = true;
      return error as Error & { code?: string };
    });
    controller.abort();
    try {
      await vi.waitFor(() => expect(rejected).toBe(true), {
        timeout: 100,
        interval: 1,
      });
    } finally {
      fake.login.resolve();
    }
    expect(await observed).toMatchObject({ code: "ECANCEL" });
    await vi.waitFor(() =>
      expect(fake.getPool().close).toHaveBeenCalledTimes(2),
    );
    expect(fake.getPool().request).not.toHaveBeenCalled();
  });
  it("does not construct a pool for an already cancelled call", async () => {
    const fake = fakeDriver();
    const controller = new AbortController();
    controller.abort();
    const opening = createMssqlDriver({ driver: fake.driver }).open(
      config,
      controller.signal,
    );
    fake.login.resolve();
    await expect(opening).rejects.toMatchObject({ code: "ECANCEL" });
    expect(fake.hasPool()).toBe(false);
  });
  it("keeps trusted connector and TLS hostname settings while combining caller cancellation", async () => {
    const fake = fakeDriver();
    const caller = new AbortController();
    const tedious = new AbortController();
    const socket = new Socket();
    const trusted = vi.fn(async () => socket);
    const opening = createMssqlDriver({
      driver: fake.driver,
      connector: trusted,
      serverName: "sql.example.com",
    }).open(config, caller.signal);
    const rejected = opening.catch(() => undefined);
    const pool = fake.getPool();
    expect(pool.config.server).toBe(config.server);
    expect(pool.config.options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
      serverName: "sql.example.com",
    });
    expect(await connectorOf(pool)(socketOptions, lookup, tedious.signal)).toBe(
      socket,
    );
    const supplied = trusted.mock.calls[0] as unknown as [
      typeof socketOptions,
      LookupFunction,
      AbortSignal,
    ];
    expect(supplied[0]).toEqual(socketOptions);
    expect(supplied[1]).toBe(lookup);
    expect(supplied[2].aborted).toBe(false);
    caller.abort();
    expect(supplied[2].aborted).toBe(true);
    fake.login.resolve();
    await rejected;
    socket.destroy();
  });
  it("retains Tedious cancellation and detaches the opening caller after a successful connection", async () => {
    const fake = fakeDriver();
    const caller = new AbortController();
    const socket = new Socket();
    const trusted = vi.fn(async () => socket);
    const opening = createMssqlDriver({
      driver: fake.driver,
      connector: trusted,
    }).open(config, caller.signal);
    fake.login.resolve();
    const connection = await opening;
    caller.abort();
    const tedious = new AbortController();
    await connectorOf(fake.getPool())(socketOptions, lookup, tedious.signal);
    const supplied = trusted.mock.calls[0] as unknown as [
      typeof socketOptions,
      LookupFunction,
      AbortSignal,
    ];
    expect(supplied[2].aborted).toBe(false);
    tedious.abort();
    expect(supplied[2].aborted).toBe(true);
    await connection.destroy();
    socket.destroy();
  });
});
