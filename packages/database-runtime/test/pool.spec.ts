import { beforeAll, describe, expect, it, vi } from "vitest";
import { databaseAllowedTargetSchema } from "@chat/contracts/database/allowlist";
import { databaseCredentialAad } from "@chat/contracts/database/credential";
import type {
  DatabaseRuntimeConfig,
  DatabaseRuntimeRequest,
} from "@chat/contracts/database/runtime";
import {
  generateCredentialKeyPair,
  sealCredential,
  type CredentialKeyPair,
  type SealedCredential,
} from "@chat/credential-seal/seal";
import {
  DatabaseRuntimePool,
  type RuntimeExecutor,
  type RuntimeSession,
} from "../src/pool.ts";

const ids = {
  workspaceId: "0199aabb-0000-7000-8000-000000000001",
  userId: "0199aabb-0000-7000-8000-000000000002",
  connectionId: "0199aabb-0000-7000-8000-000000000003",
  sourceId: "0199aabb-0000-7000-8000-000000000004",
  requestId: "0199aabb-0000-7000-8000-000000000005",
};
const EXECUTOR = "0199aabb-0000-7000-8000-000000000008";
const allowed = ["sql.example.com:1433", "pg.example.com:5432"].map((target) =>
  databaseAllowedTargetSchema.parse(target),
);
const connector = (
  overrides: Partial<
    Omit<Extract<RuntimeExecutor, { kind: "connector" }>, "kind">
  > = {},
): RuntimeExecutor => ({
  kind: "connector",
  connectorId: EXECUTOR,
  workspaceId: ids.workspaceId,
  allowlist: async () => allowed,
  ...overrides,
});
let pair: CredentialKeyPair;
let keys: ReadonlyMap<string, JsonWebKey>;
let mssqlCredential: SealedCredential;
let postgresCredential: SealedCredential;
const seal = (
  password: string,
  target: Omit<Parameters<typeof databaseCredentialAad>[0], "executor">,
  executor = EXECUTOR,
) =>
  sealCredential(
    pair.publicKey,
    password,
    databaseCredentialAad({ ...target, executor }),
  );
beforeAll(async () => {
  pair = await generateCredentialKeyPair();
  keys = new Map([[pair.keyId, pair.privateKey]]);
  mssqlCredential = await seal("private-password", {
    workspaceId: ids.workspaceId,
    server: "sql.example.com",
    port: 1433,
    username: "reader",
    transport: {
      provider: "mssql",
      encrypt: true,
      trustServerCertificate: false,
    },
  });
  postgresCredential = await seal("pg-password", {
    workspaceId: ids.workspaceId,
    server: "pg.example.com",
    port: 5432,
    username: "reader",
    transport: { provider: "postgresql", sslMode: "verify-full" },
  });
});
function request(version = 1): DatabaseRuntimeRequest & {
  config: Extract<DatabaseRuntimeConfig, { provider: "mssql" }>;
} {
  return {
    metadata: {
      ...ids,
      configVersion: version,
      credentialsVersion: version,
      deadline: new Date(Date.now() + 60000).toISOString(),
    },
    config: {
      provider: "mssql",
      server: "sql.example.com",
      port: 1433,
      database: "Sales",
      username: "reader",
      credential: mssqlCredential,
      encrypt: true,
      trustServerCertificate: false,
      connectTimeoutMs: 15000,
      queryTimeoutMs: 30000,
    },
    operation: { kind: "tools/list" },
  };
}
function session(): RuntimeSession {
  return {
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({
      blocks: [],
      dropped: 0,
      isError: false,
      structuredContent: undefined,
    })),
    probe: vi.fn(async () => {}),
    discoverDatabases: vi.fn(async () => ["Sales", "Archive"]),
    close: vi.fn(async () => {}),
  };
}
describe("database runtime isolation", () => {
  it("lists only the four read tools even when the server offers more", async () => {
    const live = session();
    live.listTools = vi.fn(async () =>
      [
        "describe_connection",
        "search_catalog",
        "describe_table",
        "run_query",
        "write_rows",
        "execute_procedure",
      ].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    );
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => live,
    });
    const response = await pool.execute(request());
    await pool.close();

    expect(response).toMatchObject({ ok: true });
    expect(
      response.ok && response.result.kind === "tools/list"
        ? response.result.tools.map((tool) => tool.name).sort()
        : [],
    ).toEqual([
      "describe_connection",
      "describe_table",
      "run_query",
      "search_catalog",
    ]);
  });

  it("preserves readiness without turning successful connectivity into a permission claim", async () => {
    const live = session();
    live.probe = vi.fn(async () => ({
      metadata: "unknown" as const,
      readOnly: "principal_required" as const,
      principal: "read_only" as const,
    }));
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => live,
    });
    expect(
      await pool.execute({ ...request(), operation: { kind: "test" } }),
    ).toMatchObject({
      ok: true,
      result: {
        connected: true,
        readiness: { metadata: "unknown", readOnly: "principal_required" },
      },
    });
    await pool.close();
  });

  it.each([
    ["principal_required", "writable", false],
    ["principal_required", "administrator", false],
    ["principal_required", "unknown", false],
    ["session", "administrator", false],
    ["session", "writable", true],
    ["principal_required", "read_only", true],
  ] as const)(
    "validates a source on a %s session with a %s principal: %s",
    async (readOnly, principal, valid) => {
      const live = session();
      live.probe = vi.fn(async () => ({
        metadata: "readable" as const,
        readOnly,
        principal,
      }));
      const pool = new DatabaseRuntimePool({
        keys,
        executor: connector(),
        factory: async () => live,
      });
      expect(
        await pool.execute({
          ...request(),
          operation: { kind: "validate_source", database: "Sales" },
        }),
      ).toMatchObject(
        valid
          ? { ok: true, result: { kind: "validate_source", valid: true } }
          : { ok: false, error: "principal_not_read_only" },
      );
      await pool.close();
    },
  );

  it.each(["verify-full"] as const)(
    "preserves managed PostgreSQL TLS mode %s",
    async (sslMode) => {
      const job = request();
      const factory = vi.fn(async (_config: DatabaseRuntimeConfig) =>
        session(),
      );
      const pool = new DatabaseRuntimePool({
        keys,
        executor: { kind: "managed" },
        factory,
      });
      const result = await pool.execute({
        ...job,
        config: {
          provider: "postgresql",
          server: "pg.example.com",
          port: 5432,
          database: "Sales",
          username: "reader",
          credential: await seal(
            "pg-password",
            {
              workspaceId: ids.workspaceId,
              server: "pg.example.com",
              port: 5432,
              username: "reader",
              transport: { provider: "postgresql", sslMode },
            },
            "managed",
          ),
          sslMode,
          connectTimeoutMs: 15000,
          queryTimeoutMs: 30000,
        },
      });
      expect(result).toMatchObject({ ok: true });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[0]).toMatchObject({ sslMode });
      await pool.close();
    },
  );

  it("keeps PostgreSQL source names exact when opening validation sessions", async () => {
    const job = request();
    const factory = vi.fn(async (_config: DatabaseRuntimeConfig) => session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
    });
    const config = {
      provider: "postgresql" as const,
      server: "pg.example.com",
      port: 5432,
      database: "postgres",
      username: "reader",
      credential: postgresCredential,
      sslMode: "verify-full" as const,
      connectTimeoutMs: 15000,
      queryTimeoutMs: 30000,
    };
    for (const database of ["Sales", "sales"])
      expect(
        await pool.execute({
          ...job,
          config,
          operation: { kind: "validate_source", database },
        }),
      ).toMatchObject({ ok: true });
    expect(factory.mock.calls.map(([value]) => value.database)).toEqual([
      "Sales",
      "sales",
    ]);
    await pool.close();
  });

  it("delegates connectivity and source validation to provider operations", async () => {
    const live = session();
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => live,
    });
    const job = request();
    expect(
      await pool.execute({ ...job, operation: { kind: "test" } }),
    ).toMatchObject({ ok: true, result: { connected: true } });
    expect(
      await pool.execute({
        ...job,
        operation: { kind: "validate_source", database: "Sales" },
      }),
    ).toMatchObject({ ok: true, result: { valid: true, database: "Sales" } });
    expect(live.probe).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("uses provider discovery results without requiring SQL rows in the shared pool", async () => {
    const live = session();
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => live,
    });
    expect(
      await pool.execute({ ...request(), operation: { kind: "discover" } }),
    ).toMatchObject({ ok: true, result: { databases: ["Sales", "Archive"] } });
    expect(live.discoverDatabases).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("reuses a same-key session created while capacity eviction waits", async () => {
    const live = session();
    let finish: () => void = () => {};
    live.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const resources: RuntimeSession[] = [];
    const factory = vi.fn(async () => {
      const value = resources.length === 0 ? live : session();
      resources.push(value);
      return value;
    });
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
      maxSources: 2,
    });
    const job = request();
    await pool.execute(job);
    await pool.execute({ ...job, config: { ...job.config, database: "B" } });
    const target = { ...job, config: { ...job.config, database: "Shared" } };
    const waiting = pool.execute(target);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await pool.execute(target);
    finish();
    await waiting;
    await pool.close();
    expect(factory).toHaveBeenCalledTimes(3);
    expect(
      resources.every(
        (resource) => vi.mocked(resource.close).mock.calls.length === 1,
      ),
    ).toBe(true);
  });

  it("honors deadlines during idle cleanup without opening another resource", async () => {
    const live = session();
    let finish: () => void = () => {};
    live.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let now = Date.now();
    const factory = vi.fn(async () => live);
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
      idleMs: 1,
      now: () => now,
    });
    await pool.execute(request());
    now += 2;
    const job = request();
    const result = await pool.execute({
      ...job,
      metadata: { ...job.metadata, deadline: new Date(now + 20).toISOString() },
    });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(factory).toHaveBeenCalledOnce();
    finish();
    await pool.close();
  });

  it("rechecks capacity when another call takes an evicted slot", async () => {
    const live = session();
    let finish: () => void = () => {};
    live.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const created: RuntimeSession[] = [];
    const factory = vi.fn(async () => {
      const value = created.length === 0 ? live : session();
      created.push(value);
      return value;
    });
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
      maxSources: 1,
    });
    await pool.execute(request());
    const job = request();
    const pending = pool.execute({
      ...job,
      config: { ...job.config, database: "B" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await pool.execute({ ...job, config: { ...job.config, database: "C" } });
    finish();
    await pending;
    expect(created[1]?.close).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("cancels a request while its factory is still pending", async () => {
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => new Promise<RuntimeSession>(() => {}),
    });
    const abort = new AbortController();
    const result = pool.execute(request(), abort.signal);
    abort.abort();
    expect(await result).toMatchObject({ ok: false, error: "cancelled" });
  });

  it("evicts idle pools and respects the configured source cap", async () => {
    const first = session(),
      second = session();
    let now = Date.now();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
      maxSources: 1,
      idleMs: 1000,
      now: () => now,
    });
    await pool.execute(request());
    const job = request();
    await pool.execute({
      ...job,
      config: { ...job.config, database: "Other" },
    });
    expect(first.close).toHaveBeenCalledOnce();
    now += 1001;
    await pool.sweep();
    expect(second.close).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("closes matching current pools on invalidation, including equal revisions", async () => {
    const live = session();
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory: async () => live,
    });
    await pool.execute(request());
    await pool.execute({ ...request(), operation: { kind: "close" } });
    expect(live.close).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("isolates sources and users despite identical database names", async () => {
    const factory = vi.fn(async () => session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
    });
    await pool.execute(request());
    await pool.execute({
      ...request(),
      metadata: {
        ...request().metadata,
        sourceId: "0199aabb-0000-7000-8000-000000000006",
      },
    });
    await pool.execute({
      ...request(),
      metadata: {
        ...request().metadata,
        userId: "0199aabb-0000-7000-8000-000000000007",
      },
    });
    expect(factory).toHaveBeenCalledTimes(3);
    await pool.close();
  });

  it("closes old pools after credential rotation and rejects late old revisions", async () => {
    const first = session(),
      factory = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
    });
    await pool.execute(request());
    await pool.execute(request(2));
    expect(first.close).toHaveBeenCalledOnce();
    expect(await pool.execute(request())).toMatchObject({
      ok: false,
      error: "stale_configuration",
    });
    await pool.close();
  });

  it("does not open a pool for an expired request", async () => {
    const factory = vi.fn(async () => session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
    });
    const job = request();
    expect(
      await pool.execute({
        ...job,
        metadata: { ...job.metadata, deadline: new Date(0).toISOString() },
      }),
    ).toMatchObject({ ok: false, error: "timeout" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects arbitrary operations and prevents certificate or encryption bypass in managed mode", async () => {
    const pool = new DatabaseRuntimePool({
      keys,
      executor: { kind: "managed" },
      factory: async () => session(),
    });
    const job = request();
    expect(
      await pool.execute({
        ...job,
        config: { ...job.config, trustServerCertificate: true },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await pool.execute({
        ...job,
        config: { ...job.config, encrypt: false },
      }),
    ).toMatchObject({ ok: false, error: "certificate_failed" });
    expect(
      await pool.execute({
        ...job,
        operation: {
          kind: "tools/call",
          name: "arbitrary_shell",
          arguments: {},
        },
      }),
    ).toMatchObject({ ok: false, error: "invalid_operation" });
    await pool.close();
  });

  it("opens the sealed password and hands it only to the session factory", async () => {
    const factory = vi.fn(
      async (_config: DatabaseRuntimeConfig, _password: string) => session(),
    );
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector(),
      factory,
    });
    const result = await pool.execute(request());
    expect(factory.mock.calls[0]?.[1]).toBe("private-password");
    expect(JSON.stringify(result)).not.toContain("private-password");
    await pool.close();
  });

  it.each([
    ["another server", { server: "evil.example.com" }, {}],
    ["another port", { port: 1434 }, {}],
    ["another SQL login", { username: "sa" }, {}],
    ["weaker TLS", { trustServerCertificate: true }, {}],
    [
      "another device",
      {},
      { connectorId: "0199aabb-0000-7000-8000-000000000009" },
    ],
    [
      "another workspace",
      {},
      { workspaceId: "0199aabb-0000-7000-8000-00000000000a" },
    ],
  ] as const)(
    "refuses a sealed password redirected to %s",
    async (_, config, identity) => {
      const factory = vi.fn(async () => session());
      const pool = new DatabaseRuntimePool({
        keys,
        executor: connector({
          ...identity,
          allowlist: async () => [
            ...allowed,
            ...["evil.example.com:1433", "sql.example.com:1434"].map((target) =>
              databaseAllowedTargetSchema.parse(target),
            ),
          ],
        }),
        factory,
      });
      const job = request();
      expect(
        await pool.execute({
          metadata: {
            ...job.metadata,
            workspaceId:
              "workspaceId" in identity
                ? identity.workspaceId
                : job.metadata.workspaceId,
          },
          config: { ...job.config, ...config },
          operation: job.operation,
        }),
      ).toMatchObject({ ok: false, error: "credential_rejected" });
      expect(factory).not.toHaveBeenCalled();
      await pool.close();
    },
  );

  it.each([
    ["a query", {}],
    ["a close", { operation: { kind: "close" } }],
  ] as const)(
    "refuses %s from another workspace before touching its sessions or password",
    async (_, operation) => {
      const own = "0199aabb-0000-7000-8000-00000000000b";
      const factory = vi.fn(async () => session());
      const opened = new Map(keys);
      const get = vi.spyOn(opened, "get");
      const pool = new DatabaseRuntimePool({
        keys: opened,
        executor: connector({ workspaceId: own }),
        factory,
      });
      const job = request();
      const credential = await seal("private-password", {
        workspaceId: own,
        server: "sql.example.com",
        port: 1433,
        username: "reader",
        transport: {
          provider: "mssql",
          encrypt: true,
          trustServerCertificate: false,
        },
      });
      expect(
        await pool.execute({
          ...job,
          config: { ...job.config, credential },
          ...operation,
        }),
      ).toMatchObject({ ok: false, error: "invalid_operation" });
      expect(get).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      await pool.close();
    },
  );

  it("reports a key the executor does not hold apart from a rejected envelope", async () => {
    const other = await generateCredentialKeyPair();
    const pool = new DatabaseRuntimePool({
      keys: new Map([[other.keyId, other.privateKey]]),
      executor: connector(),
      factory: async () => session(),
    });
    expect(await pool.execute(request())).toMatchObject({
      ok: false,
      error: "credential_key_unavailable",
    });
    await pool.close();
  });
});

describe("connector allowlist", () => {
  it.each([
    [
      "a server outside the allowlist",
      { server: "sql02.example.com" },
      allowed,
    ],
    ["a port outside the allowlist", { port: 1434 }, allowed],
    ["any server while the allowlist is empty", {}, []],
  ] as const)(
    "refuses %s before opening the password or a connection",
    async (_, target, list) => {
      const factory = vi.fn(async () => session());
      const opened = new Map(keys);
      const get = vi.spyOn(opened, "get");
      const pool = new DatabaseRuntimePool({
        keys: opened,
        executor: connector({ allowlist: async () => list }),
        factory,
      });
      const job = request();
      expect(
        await pool.execute({ ...job, config: { ...job.config, ...target } }),
      ).toMatchObject({ ok: false, error: "target_not_allowed" });
      expect(get).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      await pool.close();
    },
  );

  it("denies every target when the allowlist cannot be read", async () => {
    const factory = vi.fn(async () => session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector({
        allowlist: async () => {
          throw new Error(
            "Connector allowlist requires owner-only permissions",
          );
        },
      }),
      factory,
    });
    expect(await pool.execute(request())).toMatchObject({
      ok: false,
      error: "target_not_allowed",
    });
    expect(factory).not.toHaveBeenCalled();
    await pool.close();
  });

  it("reads the allowlist for every job, so an added target works and a removed one stops without a restart", async () => {
    const list: (typeof allowed)[number][] = [];
    const factory = vi.fn(async () => session());
    const pool = new DatabaseRuntimePool({
      keys,
      executor: connector({ allowlist: async () => list }),
      factory,
    });
    expect(await pool.execute(request())).toMatchObject({
      error: "target_not_allowed",
    });

    list.push(databaseAllowedTargetSchema.parse("SQL.example.com:1433"));
    expect(await pool.execute(request())).toMatchObject({ ok: true });

    list.length = 0;
    expect(await pool.execute(request())).toMatchObject({
      error: "target_not_allowed",
    });
    expect(factory).toHaveBeenCalledOnce();
    await pool.close();
  });
});
