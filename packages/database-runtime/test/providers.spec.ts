import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/providers.ts";

const factories = vi.hoisted(() => ({
  mssqlSource: vi.fn(() => ({})),
  postgresSource: vi.fn(() => ({})),
  mssqlServer: vi.fn(() => ({})),
  postgresServer: vi.fn(() => ({})),
}));
vi.mock("@sezzlee/mssql-mcp", () => ({
  createMssqlSource: factories.mssqlSource,
  createMssqlMcpServer: factories.mssqlServer,
}));
vi.mock("@sezzlee/postgres-mcp", () => ({
  createPostgresSource: factories.postgresSource,
  createPostgresMcpServer: factories.postgresServer,
}));

const common = {
  server: "db.example.com",
  database: "Sales",
  username: "reader",
  credential: { v: 1 as const, kid: "k", epk: "e", iv: "i", ct: "c" },
  connectTimeoutMs: 15000,
  queryTimeoutMs: 30000,
};
const target = {
  hostname: "db.example.com",
  address: "8.8.8.8",
  port: 5432,
  reach: "public",
} as const;

describe("private provider dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins PostgreSQL dialing while retaining its original certificate hostname", () => {
    createProvider(
      { ...common, provider: "postgresql", port: 5432, sslMode: "verify-full" },
      "private-password",
      target,
    );
    expect(factories.postgresSource).toHaveBeenCalledWith(
      {
        server: "db.example.com",
        port: 5432,
        database: "Sales",
        user: "reader",
        password: "private-password",
        sslMode: "verify-full",
        connectTimeoutMs: 15000,
        queryTimeoutMs: 30000,
      },
      { host: "8.8.8.8", serverName: "db.example.com" },
    );
    expect(factories.mssqlSource).not.toHaveBeenCalled();
    expect(factories.postgresServer).toHaveBeenCalledOnce();
  });

  it("preserves MSSQL certificate policy and pinned connector wiring", () => {
    createProvider(
      {
        ...common,
        provider: "mssql",
        port: 1433,
        encrypt: true,
        trustServerCertificate: false,
      },
      "private-password",
      { ...target, port: 1433 },
    );
    expect(factories.mssqlSource).toHaveBeenCalledWith(
      expect.objectContaining({ encrypt: true, trustServerCertificate: false }),
      { serverName: "db.example.com", connector: expect.any(Function) },
    );
    expect(factories.postgresSource).not.toHaveBeenCalled();
    expect(factories.mssqlServer).toHaveBeenCalledOnce();
  });

  it("logs an unexpected tool error by its tool and class only", () => {
    createProvider(
      { ...common, provider: "postgresql", port: 5432, sslMode: "verify-full" },
      "private-password",
      target,
    );
    const options: unknown = factories.postgresServer.mock.calls.at(0)?.at(1);
    if (
      typeof options !== "object" ||
      options === null ||
      !("report" in options) ||
      typeof options.report !== "function"
    )
      throw new Error("the server was built without a reporter");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    options.report(
      "run_query",
      new TypeError("connect db.example.com:5432 as reader: private-password"),
    );
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");
    stderr.mockRestore();

    expect(written).toBe("database_tool_failed run_query TypeError\n");
  });

  it.each([
    ["MSSQL", "mssql" as const, factories.mssqlServer],
    ["PostgreSQL", "postgresql" as const, factories.postgresServer],
  ])(
    "builds the %s server with every reading tool gated on the read-only login",
    (_, provider, server) => {
      createProvider(
        provider === "mssql"
          ? {
              ...common,
              provider,
              port: 1433,
              encrypt: true,
              trustServerCertificate: false,
            }
          : { ...common, provider, port: 5432, sslMode: "verify-full" },
        "private-password",
        target,
      );
      expect(server).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ principalGate: "every_read" }),
      );
    },
  );
});
