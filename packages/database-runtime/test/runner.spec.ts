import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { databaseAllowedTargetSchema } from "@chat/contracts/database/allowlist";
import { databaseCredentialAad } from "@chat/contracts/database/credential";
import type { DatabaseRuntimeRequest } from "@chat/contracts/database/runtime";
import {
  generateCredentialKeyPair,
  sealCredential,
} from "@chat/credential-seal/seal";
import { DatabaseRuntimePool, type RuntimeSession } from "../src/pool.ts";
import {
  DatabaseExecutorApi,
  databaseApiUrl,
  ExecutorTransportError,
  runDatabaseExecutor,
} from "../src/runner.ts";

describe("database executor transport", () => {
  it("requires HTTPS and refuses URL credentials and nonlocal HTTP", () => {
    expect(() => databaseApiUrl("http://api.example.com", true)).toThrow();
    expect(() =>
      databaseApiUrl("https://user:secret@api.example.com"),
    ).toThrow();
    expect(() => databaseApiUrl("http://localhost:3000/api")).toThrow();
    expect(() =>
      databaseApiUrl("https://api.example.com/api?token=secret"),
    ).toThrow("Invalid database API URL");
    expect(() => databaseApiUrl("https://api.example.com/api#frag")).toThrow(
      "Invalid database API URL",
    );
    expect(databaseApiUrl("http://localhost:3000/api", true).pathname).toBe(
      "/api/",
    );
  });
  it("preserves the API prefix, refuses redirects and sends tokens only in headers", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"accepted":true}'));
    const api = new DatabaseExecutorApi(
      databaseApiUrl("https://api.example.com/api"),
      "device-secret",
      transport,
    );
    await api.post(
      "executor/results",
      { requestId: "opaque" },
      z.object({ accepted: z.boolean() }),
      AbortSignal.timeout(1000),
    );
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      "https://api.example.com/api/databases/executor/results",
    );
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer device-secret" },
    });
    expect(transport.mock.calls[0]?.[1]?.body).not.toContain("device-secret");
  });
  it("returns a safe error without server text or credentials", async () => {
    const api = new DatabaseExecutorApi(
      databaseApiUrl("https://api.example.com"),
      "secret",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private error content", { status: 401 }),
        ),
    );
    await expect(
      api.post("executor/poll", {}, z.unknown(), AbortSignal.timeout(1000)),
    ).rejects.toEqual(new ExecutorTransportError("authorization"));
  });
  it("validates untrusted responses", async () => {
    const api = new DatabaseExecutorApi(
      databaseApiUrl("https://api.example.com"),
      "secret",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"accepted":"yes"}')),
    );
    await expect(
      api.post(
        "executor/results",
        {},
        z.object({ accepted: z.boolean() }),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toEqual(new ExecutorTransportError("invalid_response"));
  });
});

const EXECUTOR = "0199aabb-0000-7000-8000-000000000008";
const WORKSPACE = "0199aabb-0000-7000-8000-000000000001";
const LEASE = "0199aabb-0000-7000-8000-000000000009";

async function leasedQuery() {
  const pair = await generateCredentialKeyPair();
  const credential = await sealCredential(
    pair.publicKey,
    "private-password",
    databaseCredentialAad({
      workspaceId: WORKSPACE,
      executor: EXECUTOR,
      server: "sql.example.com",
      port: 1433,
      username: "reader",
      transport: {
        provider: "mssql",
        encrypt: true,
        trustServerCertificate: false,
      },
    }),
  );
  const job: DatabaseRuntimeRequest = {
    metadata: {
      workspaceId: WORKSPACE,
      userId: "0199aabb-0000-7000-8000-000000000002",
      connectionId: "0199aabb-0000-7000-8000-000000000003",
      sourceId: "0199aabb-0000-7000-8000-000000000004",
      requestId: "0199aabb-0000-7000-8000-000000000005",
      configVersion: 1,
      credentialsVersion: 1,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    config: {
      provider: "mssql",
      server: "sql.example.com",
      port: 1433,
      database: "Sales",
      username: "reader",
      credential,
      encrypt: true,
      trustServerCertificate: false,
      connectTimeoutMs: 15_000,
      queryTimeoutMs: 30_000,
    },
    operation: {
      kind: "tools/call",
      name: "run_query",
      arguments: { sql: "SELECT 1" },
    },
  };
  return { pair, job };
}

const idle = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });

const routeOf = (input: Parameters<typeof fetch>[0]) =>
  new URL(String(input)).pathname.replace("/api/databases/", "");

describe("database executor runner", () => {
  it("aborts the running SQL when the API refuses its heartbeat and reports the job cancelled, never its result", async () => {
    const { pair, job } = await leasedQuery();
    let sqlAborted = false;
    let startSql: () => void = () => undefined;
    const sqlStarted = new Promise<void>((resolve) => {
      startSql = resolve;
    });
    const live: RuntimeSession = {
      listTools: async () => [],
      callTool: (_name, _args, signal) =>
        new Promise((_resolve, reject) => {
          startSql();
          signal?.addEventListener(
            "abort",
            () => {
              sqlAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      probe: async () => undefined,
      discoverDatabases: async () => [],
      close: async () => undefined,
    };
    const pool = new DatabaseRuntimePool({
      executor: {
        kind: "connector",
        connectorId: EXECUTOR,
        workspaceId: WORKSPACE,
        allowlist: async () => [
          databaseAllowedTargetSchema.parse("sql.example.com:1433"),
        ],
      },
      keys: new Map([[pair.keyId, pair.privateKey]]),
      factory: async () => live,
    });
    const stop = new AbortController();
    const routes: string[] = [];
    let polls = 0;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const route = routeOf(input);
      routes.push(route);
      if (route === "executor/poll") {
        polls += 1;
        return polls === 1
          ? Response.json({ job, leaseId: LEASE })
          : idle(init?.signal);
      }
      if (route === "executor/heartbeat") {
        await sqlStarted;
        return Response.json({ accepted: false, cancelled: true });
      }
      if (route === "executor/cancel") stop.abort();
      return Response.json({ accepted: true });
    });
    const events: string[] = [];

    await runDatabaseExecutor({
      api: new DatabaseExecutorApi(
        databaseApiUrl("https://api.example.com/api"),
        "device-token",
        transport,
      ),
      pool,
      signal: stop.signal,
      heartbeatMs: 10,
      onEvent: (event) => events.push(event),
    });

    expect(sqlAborted).toBe(true);
    expect(routes).toContain("executor/cancel");
    expect(routes).not.toContain("executor/results");
    expect(events).toContain("job_cancelled");
  });

  it("stops every lease loop without retrying and closes the pool once the API refuses the token", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 401 }));
    const events: string[] = [];
    const pool = new DatabaseRuntimePool({
      executor: {
        kind: "connector",
        connectorId: EXECUTOR,
        workspaceId: WORKSPACE,
        allowlist: async () => [],
      },
      keys: new Map(),
      factory: async () => {
        throw new Error("no job may reach the database");
      },
    });
    const close = vi.spyOn(pool, "close");

    await expect(
      runDatabaseExecutor({
        api: new DatabaseExecutorApi(
          databaseApiUrl("https://api.example.com/api"),
          "revoked-token",
          transport,
        ),
        pool,
        signal: new AbortController().signal,
        concurrency: 3,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toEqual(new ExecutorTransportError("authorization"));
    expect(transport).toHaveBeenCalledTimes(3);
    expect(events).toContain("authorization_failed");
    expect(events).not.toContain("retry");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses an API response larger than 16 MB", async () => {
    const megabyte = new Uint8Array(1024 * 1024).fill(32);
    const api = new DatabaseExecutorApi(
      databaseApiUrl("https://api.example.com"),
      "secret",
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let index = 0; index <= 16; index += 1)
                  controller.enqueue(megabyte);
                controller.close();
              },
            }),
          ),
      ),
    );

    await expect(
      api.post("executor/poll", {}, z.unknown(), AbortSignal.timeout(5000)),
    ).rejects.toEqual(new ExecutorTransportError("invalid_response"));
  });
});
