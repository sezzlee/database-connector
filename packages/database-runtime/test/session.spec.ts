import { describe, expect, it, vi } from "vitest";
import * as mssql from "@sezzlee/mssql-mcp";
import { createRuntimeSession } from "../src/session.ts";

describe("existing MSSQL MCP memory transport", () => {
  it("checks metadata through valid native MCP catalog arguments", async () => {
    const original = mssql.createMssqlSource;
    const factory = vi
      .spyOn(mssql, "createMssqlSource")
      .mockImplementation((config, options) => {
        const source = original(config, options);
        vi.spyOn(source.runner, "run").mockResolvedValue({
          columns: [],
          rows: [],
          more: false,
        });
        vi.spyOn(source, "principal").mockResolvedValue("read_only");
        return source;
      });
    const session = await createRuntimeSession(
      {
        provider: "mssql",
        server: "127.0.0.1",
        port: 1,
        database: "fixture",
        username: "reader",
        credential: { v: 1 as const, kid: "k", epk: "e", iv: "i", ct: "c" },
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMs: 1000,
        queryTimeoutMs: 1000,
      },
      "fixture-secret",
      "connector",
    );
    try {
      expect(await session.probe()).toEqual({
        metadata: "readable",
        readOnly: "principal_required",
        principal: "read_only",
      });
    } finally {
      await session.close();
      factory.mockRestore();
    }
  });

  it("discovers the four native tools and rejects write/batch SQL before connecting", async () => {
    const session = await createRuntimeSession(
      {
        provider: "mssql",
        server: "127.0.0.1",
        port: 1,
        database: "fixture",
        username: "reader",
        credential: { v: 1 as const, kid: "k", epk: "e", iv: "i", ct: "c" },
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMs: 1000,
        queryTimeoutMs: 1000,
      },
      "fixture-secret",
      "connector",
    );
    try {
      const tools = await session.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "describe_connection",
        "describe_table",
        "run_query",
        "search_catalog",
      ]);
      for (const sql of ["DELETE FROM Orders", "SELECT 1; SELECT 2"]) {
        const result = await session.callTool(
          "run_query",
          { sql },
          AbortSignal.timeout(2000),
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("fixture-secret");
        expect(JSON.stringify(result)).not.toContain("127.0.0.1");
        expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|ETIMEOUT/);
      }
    } finally {
      await session.close();
    }
  });

  it("keeps the SQL login out of describe_connection", async () => {
    const login = "sales_reader_7f3a";
    const original = mssql.createMssqlSource;
    const factory = vi
      .spyOn(mssql, "createMssqlSource")
      .mockImplementation((config, options) => {
        const source = original(config, options);
        vi.spyOn(source.runner, "run").mockResolvedValue({
          columns: [],
          rows: [],
          more: false,
        });
        return source;
      });
    const session = await createRuntimeSession(
      {
        provider: "mssql",
        server: "127.0.0.1",
        port: 1,
        database: "fixture",
        username: login,
        credential: { v: 1 as const, kid: "k", epk: "e", iv: "i", ct: "c" },
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMs: 1000,
        queryTimeoutMs: 1000,
      },
      "fixture-secret",
      "connector",
    );
    try {
      const result = await session.callTool(
        "describe_connection",
        {},
        AbortSignal.timeout(2000),
      );

      expect(result.isError).toBe(false);
      const described: unknown[] = result.blocks.flatMap((block) =>
        block.type === "text" ? [JSON.parse(block.text)] : [],
      );
      expect(described).toContainEqual(
        expect.objectContaining({ principal: null }),
      );
      expect(JSON.stringify(result)).not.toContain(login);
    } finally {
      await session.close();
      factory.mockRestore();
    }
  });
});
