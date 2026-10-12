import { dbCoreLimits } from "@sezzlee/db-core";

export const limits = {
  ...dbCoreLimits,
  /**
   * Guard: measured, not chosen — `request.timeout` does not interrupt a running
   * statement on this driver (on mssql@11.0.2, `request.timeout = 800` let a
   * 10 s `waitfor delay` run to completion), so the deadline is a timer that
   * aborts the signal. It is set below the connect timeout so a
   * blocked query cannot outlive the call that asked for it.
   */
  queryTimeoutMs: 30_000,
  maxConnections: 4,
} as const;
