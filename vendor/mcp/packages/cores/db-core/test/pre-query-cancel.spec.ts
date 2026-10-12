import { expect, it } from "vitest";
import { createConnectionPool, runCancellable, sqlText } from "../src/index.js";
import { createFakeDriver, fail, rows } from "./fake.js";

it("does not issue SQL when cancellation arrives after acquiring the lease", async () => {
  const driver = createFakeDriver({ respond: () => rows([], []) });
  const limits = {
    maxConnections: 1,
    maxQueueDepth: 1,
    connectTimeoutMs: 1000,
    cancelSettleMs: 50,
  };
  const pool = createConnectionPool({
    driver: driver.adapter,
    config: { host: "sql.internal", password: "test-password" },
    limits,
    fail,
    sessionSetup: [],
  });
  const lease = await pool.acquire();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCancellable(
      lease,
      { sql: sqlText("SELECT 1"), parameters: [], timeoutMs: 1000, maxRows: 1 },
      controller.signal,
      limits,
      fail,
    ),
  ).rejects.toMatchObject({ code: "query_cancelled" });
  expect(driver.stats.ran).toEqual([]);
  expect(driver.stats.cancels).toBe(0);
  lease.release();
  await pool.close();
});
