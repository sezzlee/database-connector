import { describe, expect, it } from "vitest";
import { createConnectionPool, runCancellable, sqlText } from "../src/index.js";
import type { PoolLimits, QuerySpec } from "../src/index.js";
import { column, createFakeDriver, fail, rows } from "./fake.js";

const limits: PoolLimits = {
  maxConnections: 2,
  maxQueueDepth: 4,
  connectTimeoutMs: 1_000,
  cancelSettleMs: 50,
};

const config = { host: "db.internal", password: "hunter2" };

const query: QuerySpec = {
  sql: sqlText("select 1"),
  parameters: [],
  timeoutMs: 1_000,
  maxRows: 10,
};

function poolOf(driver: ReturnType<typeof createFakeDriver>) {
  return createConnectionPool({
    driver: driver.adapter,
    config,
    limits,
    fail,
    sessionSetup: [],
  });
}

describe("runCancellable", () => {
  it("returns the result when nothing is cancelled", async () => {
    const driver = createFakeDriver({
      respond: () => rows([column("a", 0)], [["x"]]),
    });
    const pool = poolOf(driver);
    const lease = await pool.acquire();
    const result = await runCancellable(lease, query, undefined, limits, fail);
    lease.release();
    expect(result.rows).toEqual([["x"]]);
    expect(driver.stats.cancels).toBe(0);
  });

  it("cancels the request when the signal aborts", async () => {
    const driver = createFakeDriver({ respond: () => ({ kind: "hang" }) });
    const pool = poolOf(driver);
    const lease = await pool.acquire();
    const controller = new AbortController();
    const running = runCancellable(
      lease,
      query,
      controller.signal,
      limits,
      fail,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "query_cancelled" });
    expect(driver.stats.cancels).toBe(1);
  });

  it("waits for the cancelled request to settle before the lease is reusable", async () => {
    const driver = createFakeDriver({ respond: () => ({ kind: "hang" }) });
    const pool = poolOf(driver);
    const lease = await pool.acquire();
    const controller = new AbortController();
    const running = runCancellable(
      lease,
      query,
      controller.signal,
      limits,
      fail,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "query_cancelled" });
    lease.release();

    /**
     * The fake settles on cancel, so the connection is clean and goes back to
     * the pool rather than being destroyed.
     */
    expect(driver.stats.destroyed).toBe(0);
    const next = await pool.acquire();
    expect(next.connection.id).toBe(lease.connection.id);
    next.release();
  });

  it("quarantines a connection whose cancelled request never settles", async () => {
    const driver = createFakeDriver({
      respond: () => ({ kind: "hang" }),
      settleOnCancel: false,
    });
    const pool = poolOf(driver);
    const lease = await pool.acquire();
    const controller = new AbortController();
    const running = runCancellable(
      lease,
      query,
      controller.signal,
      limits,
      fail,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "query_cancelled" });
    lease.release();

    expect(driver.stats.destroyed).toBe(1);
    const next = await pool.acquire();
    expect(next.connection.id).not.toBe(lease.connection.id);
    next.release();
  });

  it("bumps the generation when a connection is discarded", async () => {
    const driver = createFakeDriver({
      respond: () => ({ kind: "hang" }),
      settleOnCancel: false,
    });
    const pool = poolOf(driver);
    const before = pool.generation;
    const lease = await pool.acquire();
    const controller = new AbortController();
    const running = runCancellable(
      lease,
      query,
      controller.signal,
      limits,
      fail,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "query_cancelled" });
    lease.release();
    expect(pool.generation).toBeGreaterThan(before);
  });

  it("propagates a driver rejection untouched when nothing was cancelled", async () => {
    const boom = new Error("connection reset");
    const driver = createFakeDriver({
      respond: () => ({ kind: "throw", error: boom }),
    });
    const pool = poolOf(driver);
    const lease = await pool.acquire();
    await expect(
      runCancellable(lease, query, undefined, limits, fail),
    ).rejects.toBe(boom);
    lease.release();
  });
});
