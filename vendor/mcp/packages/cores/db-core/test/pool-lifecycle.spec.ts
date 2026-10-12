import { describe, expect, it, vi } from "vitest";
import {
  createConnectionPool,
  sqlText,
  type DriverAdapter,
  type DriverConnection,
  type PoolLimits,
} from "../src/index.js";
import { fail } from "./fake.js";

const limits: PoolLimits = {
  maxConnections: 1,
  maxQueueDepth: 1,
  connectTimeoutMs: 20,
  cancelSettleMs: 10,
};
const setup = {
  sql: sqlText("setup"),
  parameters: [],
  timeoutMs: 1000,
  maxRows: 0,
};
const empty = { columns: [], rows: [], more: false };
const connection = (): DriverConnection => ({
  id: 1,
  run: () => ({ settled: Promise.resolve(empty), cancel: vi.fn() }),
  destroy: vi.fn(async () => {}),
});

function deferredDriver() {
  let resolve!: (connection: DriverConnection) => void;
  let openingSignal: AbortSignal | undefined;
  const adapter: DriverAdapter<Record<string, never>> = {
    open: (_config, signal) => {
      openingSignal = signal;
      return new Promise((yes) => {
        resolve = yes;
      });
    },
    isBroken: () => false,
  };
  return {
    adapter,
    resolve: (value: DriverConnection) => resolve(value),
    signal: () => openingSignal,
  };
}

describe("physical connection opening lifecycle", () => {
  it("services queued acquisition after the first opening fails", async () => {
    let reject!: (error: unknown) => void;
    const firstOpen = new Promise<DriverConnection>((_resolve, no) => {
      reject = no;
    });
    let calls = 0;
    const pool = createConnectionPool({
      driver: {
        open: () => (++calls === 1 ? firstOpen : Promise.resolve(connection())),
        isBroken: () => false,
      },
      config: {},
      limits: { ...limits, connectTimeoutMs: 1000 },
      fail,
      sessionSetup: [],
    });
    const first = pool.acquire();
    const waiting = pool.acquire();
    reject(new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");
    try {
      const lease = await Promise.race([
        waiting,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 50),
        ),
      ]);
      expect(lease).toBeDefined();
      lease?.release();
    } finally {
      await pool.close();
    }
  });
  it("opens a replacement for queued calls after quarantine", async () => {
    const pool = createConnectionPool({
      driver: { open: async () => connection(), isBroken: () => false },
      config: {},
      limits,
      fail,
      sessionSetup: [],
    });
    const held = await pool.acquire();
    const waiting = pool.acquire();
    held.quarantine();
    held.release();
    try {
      const lease = await Promise.race([
        waiting,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 50),
        ),
      ]);
      expect(lease).toBeDefined();
      lease?.release();
    } finally {
      await pool.close();
    }
  });
  it("removes cancelled waiters from queue capacity", async () => {
    const pool = createConnectionPool({
      driver: { open: async () => connection(), isBroken: () => false },
      config: {},
      limits,
      fail,
      sessionSetup: [],
    });
    const held = await pool.acquire();
    const controller = new AbortController();
    const abandoned = pool.acquire(controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "query_cancelled" });
    const waiting = pool.acquire();
    held.release();
    try {
      (await waiting).release();
    } finally {
      await pool.close();
    }
  });
  it("destroys a connection whose session setup fails", async () => {
    const opened = connection();
    const error = new Error("setup failed");
    opened.run = () => ({ settled: Promise.reject(error), cancel: vi.fn() });
    const pool = createConnectionPool({
      driver: { open: async () => opened, isBroken: () => false },
      config: {},
      limits,
      fail,
      sessionSetup: [setup],
    });
    await expect(pool.acquire()).rejects.toBe(error);
    expect(opened.destroy).toHaveBeenCalledOnce();
    await pool.close();
  });
  it("aborts timed-out opening and destroys a late connection", async () => {
    const fake = deferredDriver();
    const opened = connection();
    const pool = createConnectionPool({
      driver: fake.adapter,
      config: {},
      limits,
      fail,
      sessionSetup: [],
    });
    await expect(pool.acquire()).rejects.toMatchObject({
      code: "connection_failed",
    });
    expect(fake.signal()?.aborted).toBe(true);
    fake.resolve(opened);
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.destroy).toHaveBeenCalledOnce();
    await pool.close();
  });
  it("rejects opening cancellation promptly even when driver ignores abort", async () => {
    const fake = deferredDriver();
    const opened = connection();
    const pool = createConnectionPool({
      driver: fake.adapter,
      config: {},
      limits: { ...limits, connectTimeoutMs: 1000 },
      fail,
      sessionSetup: [],
    });
    const controller = new AbortController();
    const acquisition = pool.acquire(controller.signal);
    controller.abort();
    await expect(acquisition).rejects.toMatchObject({
      code: "query_cancelled",
    });
    expect(fake.signal()?.aborted).toBe(true);
    fake.resolve(opened);
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.destroy).toHaveBeenCalledOnce();
    await pool.close();
  });
  it("cancels and destroys a stalled setup at the opening deadline", async () => {
    const opened = connection();
    const cancel = vi.fn();
    opened.run = () => ({ settled: new Promise(() => {}), cancel });
    const pool = createConnectionPool({
      driver: { open: async () => opened, isBroken: () => false },
      config: {},
      limits,
      fail,
      sessionSetup: [setup],
    });
    await expect(pool.acquire()).rejects.toMatchObject({
      code: "connection_failed",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(opened.destroy).toHaveBeenCalledOnce();
    await pool.close();
  });
  it("rejects pending acquisition on shutdown and destroys late opening", async () => {
    const fake = deferredDriver();
    const opened = connection();
    const pool = createConnectionPool({
      driver: fake.adapter,
      config: {},
      limits: { ...limits, connectTimeoutMs: 1000 },
      fail,
      sessionSetup: [],
    });
    const acquisition = pool.acquire();
    const rejected = expect(acquisition).rejects.toMatchObject({
      code: "internal_error",
    });
    await pool.close();
    await rejected;
    expect(fake.signal()?.aborted).toBe(true);
    fake.resolve(opened);
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.destroy).toHaveBeenCalledOnce();
  });
});
