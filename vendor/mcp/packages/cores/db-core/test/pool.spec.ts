import { describe, expect, it } from "vitest";
import { createConnectionPool } from "../src/index.js";
import type { PoolLimits } from "../src/index.js";
import { column, createFakeDriver, fail, rows } from "./fake.js";

const config = { host: "db.internal", password: "hunter2" };

const limitsWith = (over: Partial<PoolLimits> = {}): PoolLimits => ({
  maxConnections: 1,
  maxQueueDepth: 2,
  connectTimeoutMs: 1_000,
  cancelSettleMs: 50,
  ...over,
});

const okDriver = () =>
  createFakeDriver({ respond: () => rows([column("a", 0)], [["x"]]) });

describe("the connection pool", () => {
  it("opens at most maxConnections and reuses what it has", async () => {
    const driver = okDriver();
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith({ maxConnections: 2 }),
      fail,
      sessionSetup: [],
    });
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(driver.stats.opened).toBe(2);
    first.release();
    const third = await pool.acquire();
    expect(driver.stats.opened).toBe(2);
    expect(third.connection.id).toBe(first.connection.id);
    second.release();
    third.release();
  });

  it("hands a released connection straight to a waiter", async () => {
    const driver = okDriver();
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith(),
      fail,
      sessionSetup: [],
    });
    const held = await pool.acquire();
    const queued = pool.acquire();
    held.release();
    const lease = await queued;
    expect(driver.stats.opened).toBe(1);
    lease.release();
  });

  it("refuses once the wait queue is full", async () => {
    const driver = okDriver();
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith({ maxQueueDepth: 1 }),
      fail,
      sessionSetup: [],
    });
    const held = await pool.acquire();
    const queued = pool.acquire();
    await expect(pool.acquire()).rejects.toMatchObject({
      code: "resource_limit",
    });
    held.release();
    (await queued).release();
  });

  it("rejects a waiter whose signal aborts", async () => {
    const driver = okDriver();
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith(),
      fail,
      sessionSetup: [],
    });
    const held = await pool.acquire();
    const controller = new AbortController();
    const queued = pool.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "query_cancelled" });
    held.release();
  });

  it("runs the session setup once per physical connection", async () => {
    const driver = createFakeDriver({
      respond: () => rows([], []),
    });
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith(),
      fail,
      sessionSetup: [
        {
          sql: "set something" as never,
          parameters: [],
          timeoutMs: 1_000,
          maxRows: 0,
        },
      ],
    });
    const first = await pool.acquire();
    first.release();
    const second = await pool.acquire();
    second.release();
    expect(driver.stats.opened).toBe(1);
    expect(driver.stats.ran).toHaveLength(1);
  });

  it("turns a connect that never lands into connection_failed", async () => {
    const driver = createFakeDriver({
      respond: () => rows([], []),
      openError: () => new Error("ECONNREFUSED"),
    });
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith(),
      fail,
      sessionSetup: [],
    });
    await expect(pool.acquire()).rejects.toThrow("ECONNREFUSED");
  });

  it("destroys the idle connections it holds on close", async () => {
    const driver = okDriver();
    const pool = createConnectionPool({
      driver: driver.adapter,
      config,
      limits: limitsWith(),
      fail,
      sessionSetup: [],
    });
    const lease = await pool.acquire();
    lease.release();
    await pool.close();
    expect(driver.stats.destroyed).toBe(1);
    await expect(pool.acquire()).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});
