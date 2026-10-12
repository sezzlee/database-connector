import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  databaseExecutorHeartbeatResponseSchema,
  databaseExecutorPollResponseSchema,
  databaseExecutorResultResponseSchema,
  type DatabaseExecutorPollResponse,
} from "@chat/contracts/database/runtime";
import { DatabaseRuntimePool } from "./pool.ts";

export class ExecutorTransportError extends Error {
  constructor(
    readonly reason: "authorization" | "transport" | "invalid_response",
  ) {
    super(reason);
  }
}

export function databaseApiUrl(input: string, allowLocalHttp = false): URL {
  const url = new URL(input);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Invalid database API URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(allowLocalHttp && local && url.protocol === "http:")
  )
    throw new Error("Database API requires HTTPS");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

/** Redirects are refused so bearer tokens never follow an API redirect. */
export class DatabaseExecutorApi {
  constructor(
    readonly base: URL,
    private token?: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  /** Sends every later request, including those of loops already running, with a rotated token. */
  useToken(token: string): void {
    this.token = token;
  }

  async post<T>(
    route: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(
        new URL(`databases/${route}`, this.base),
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(this.token === undefined
              ? {}
              : { Authorization: `Bearer ${this.token}` }),
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new ExecutorTransportError("transport");
    }
    if (response.status === 401 || response.status === 403)
      throw new ExecutorTransportError("authorization");
    if (!response.ok || response.body === null)
      throw new ExecutorTransportError("transport");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16 * 1024 * 1024)
          throw new ExecutorTransportError("invalid_response");
        chunks.push(next.value);
      }
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      const validated = schema.safeParse(parsed);
      if (!validated.success)
        throw new ExecutorTransportError("invalid_response");
      return validated.data;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof ExecutorTransportError) throw error;
      throw new ExecutorTransportError("invalid_response");
    } finally {
      reader.releaseLock();
    }
  }
}

export interface DatabaseRunnerOptions {
  readonly api: DatabaseExecutorApi;
  readonly pool: DatabaseRuntimePool;
  readonly signal: AbortSignal;
  readonly heartbeatMs?: number;
  /** Jobs leased and run at once; each one holds its own SQL connection. */
  readonly concurrency?: number;
  /** Emit safe codes only. No input, response or thrown error is passed here. */
  readonly onEvent?: (
    event:
      | "ready"
      | "polled"
      | "retry"
      | "authorization_failed"
      | "job_completed"
      | "job_cancelled",
  ) => void;
}

function requestSignal(signal: AbortSignal, ms = 35000): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

async function executeLease(
  lease: DatabaseExecutorPollResponse,
  options: DatabaseRunnerOptions,
): Promise<void> {
  if (lease.job === undefined || lease.leaseId === undefined) return;
  const { api, pool, signal } = options;
  const job = lease.job,
    identity = { requestId: job.metadata.requestId, leaseId: lease.leaseId };
  const cancel = new AbortController();
  const heartbeatStop = new AbortController();
  let authorizationFailure: ExecutorTransportError | undefined;
  const workSignal = AbortSignal.any([signal, cancel.signal]);
  const heartbeats = (async () => {
    const stop = AbortSignal.any([signal, heartbeatStop.signal]);
    while (!stop.aborted) {
      try {
        await delay(options.heartbeatMs ?? 5000, undefined, { signal: stop });
        const state = await api.post(
          "executor/heartbeat",
          identity,
          databaseExecutorHeartbeatResponseSchema,
          requestSignal(stop, 10000),
        );
        if (!state.accepted || state.cancelled) {
          cancel.abort();
          break;
        }
      } catch (error) {
        if (
          error instanceof ExecutorTransportError &&
          error.reason === "authorization"
        )
          authorizationFailure = error;
        if (!heartbeatStop.signal.aborted) cancel.abort();
        break;
      }
    }
  })();
  try {
    const response = await pool.execute(job, workSignal);
    if (authorizationFailure !== undefined) throw authorizationFailure;
    if (workSignal.aborted) {
      options.onEvent?.("job_cancelled");
      await api
        .post(
          "executor/cancel",
          identity,
          databaseExecutorResultResponseSchema,
          AbortSignal.timeout(5000),
        )
        .catch(() => undefined);
      return;
    }
    await api.post(
      "executor/results",
      { ...identity, response },
      databaseExecutorResultResponseSchema,
      requestSignal(signal, 10000),
    );
    options.onEvent?.("job_completed");
  } finally {
    heartbeatStop.abort();
    await heartbeats;
  }
}

export async function runDatabaseExecutor(
  options: DatabaseRunnerOptions,
): Promise<void> {
  const { pool } = options;
  const halt = new AbortController();
  const signal = AbortSignal.any([options.signal, halt.signal]);
  const scoped = { ...options, signal };
  const cleanupStop = new AbortController();
  const cleanupSignal = AbortSignal.any([signal, cleanupStop.signal]);
  const sweep = (async () => {
    while (!cleanupSignal.aborted) {
      try {
        await delay(30000, undefined, { signal: cleanupSignal });
        await pool.sweep();
      } catch {
        break;
      }
    }
  })();
  options.onEvent?.("ready");
  try {
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(options.concurrency ?? 1, 32)) },
        () =>
          leaseLoop(scoped).catch((error: unknown) => {
            halt.abort();
            throw error;
          }),
      ),
    );
  } finally {
    cleanupStop.abort();
    await sweep;
    await pool.close();
  }
}

async function leaseLoop(options: DatabaseRunnerOptions): Promise<void> {
  const { api, signal } = options;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const lease = await api.post(
        "executor/poll",
        { waitMs: 25000 },
        databaseExecutorPollResponseSchema,
        requestSignal(signal),
      );
      failures = 0;
      options.onEvent?.("polled");
      await executeLease(lease, options);
      if (lease.job === undefined) await delay(250, undefined, { signal });
    } catch (error) {
      if (signal.aborted) break;
      if (
        error instanceof ExecutorTransportError &&
        error.reason === "authorization"
      ) {
        options.onEvent?.("authorization_failed");
        throw error;
      }
      options.onEvent?.("retry");
      failures += 1;
      await delay(
        Math.min(30000, 500 * 2 ** Math.min(failures, 6)) +
          Math.floor(Math.random() * 500),
        undefined,
        { signal },
      ).catch(() => undefined);
    }
  }
}
