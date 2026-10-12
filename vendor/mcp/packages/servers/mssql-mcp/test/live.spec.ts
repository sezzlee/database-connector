import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMssqlEnv } from "../src/platform/env.js";
import { createMssqlMcpServer, createMssqlSource } from "../src/server.js";
import type { DbSource } from "@sezzlee/db-core";
import type { MssqlConfig } from "../src/platform/env.js";

/**
 * Guard: the catalogue statements are the one part of this package a fake cannot
 * check — a snapshot proves the text did not change, not that the joins are
 * right. This suite runs them against a real server, and is skipped unless
 * SEZZLEE_MSSQL_LIVE is set so CI never needs a database.
 */
const live = process.env["SEZZLEE_MSSQL_LIVE"] === "1";

const outcome = readMssqlEnv({
  SEZZLEE_MSSQL_SERVER: process.env["SEZZLEE_MSSQL_SERVER"],
  SEZZLEE_MSSQL_PORT: process.env["SEZZLEE_MSSQL_PORT"],
  SEZZLEE_MSSQL_DATABASE: process.env["SEZZLEE_MSSQL_DATABASE"],
  SEZZLEE_MSSQL_USER: process.env["SEZZLEE_MSSQL_USER"],
  SEZZLEE_MSSQL_PASSWORD: process.env["SEZZLEE_MSSQL_PASSWORD"],
  SEZZLEE_MSSQL_ENCRYPT: process.env["SEZZLEE_MSSQL_ENCRYPT"],
  SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE:
    process.env["SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE"],
  SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS:
    process.env["SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS"],
  SEZZLEE_MSSQL_QUERY_TIMEOUT_MS: process.env["SEZZLEE_MSSQL_QUERY_TIMEOUT_MS"],
});

const config: MssqlConfig | undefined =
  outcome.kind === "config" ? outcome.config : undefined;

interface TextResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

function body(result: TextResult): Record<string, unknown> {
  const first = result.content[0] as { type: string; text: string };
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe.skipIf(!live || config === undefined)(
  "mssql-mcp against a real server",
  () => {
    let client: Client;
    let source: DbSource<MssqlConfig>;

    beforeAll(async () => {
      if (config === undefined) {
        throw new Error("the live suite needs a complete environment");
      }
      source = createMssqlSource(config);
      const server = createMssqlMcpServer(source);
      client = new Client({ name: "live-spec", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    });

    afterAll(async () => {
      await source?.close();
    });

    it("describes the connection it actually opened", async () => {
      const envelope = body(
        (await client.callTool({
          name: "describe_connection",
          arguments: {},
        })) as TextResult,
      );
      expect(envelope["dialect"]).toBe("mssql");
      expect(String(envelope["engineVersion"])).toMatch(/^\d+\.\d+/u);
      expect(envelope["catalog"]).toBe(config?.database);
      expect(envelope["readOnly"]).toMatchObject({ sessionIntent: "none" });
      expect(JSON.stringify(envelope)).not.toContain(config?.password ?? "");
    });

    it("pages the real catalogue, schema-qualified", async () => {
      const envelope = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { maxResults: 5 },
        })) as TextResult,
      );
      const found = envelope["results"] as {
        schema: string;
        name: string;
        kind: string;
      }[];
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(5);
      for (const entry of found) {
        expect(entry.schema.length).toBeGreaterThan(0);
        expect(["table", "view"]).toContain(entry.kind);
      }
      const facts = envelope["catalog"] as Record<string, unknown>;
      expect(typeof facts["indexedObjects"]).toBe("number");
      expect(typeof facts["indexedAt"]).toBe("string");
      expect(typeof facts["complete"]).toBe("boolean");
    });

    it("filters by schema and by name pattern", async () => {
      const envelope = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { schema: "dbo", namePattern: "%", maxResults: 3 },
        })) as TextResult,
      );
      const found = envelope["results"] as { schema: string }[];
      expect(found.every((entry) => entry.schema === "dbo")).toBe(true);
    });

    /**
     * Guard: the cursor has to resume after the last object actually sent. Two
     * pages of one must cover two distinct objects, never the same one twice.
     */
    it("walks the catalogue a page at a time without repeating an object", async () => {
      const first = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { maxResults: 1 },
        })) as TextResult,
      );
      expect(first["truncated"]).toBe(true);
      const cursor = first["nextCursor"] as string;
      expect(typeof cursor).toBe("string");

      const second = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { maxResults: 1, cursor },
        })) as TextResult,
      );
      const name = (page: Record<string, unknown>) =>
        (page["results"] as { schema: string; name: string }[])
          .map((entry) => `${entry.schema}.${entry.name}`)
          .join();
      expect(name(second)).not.toBe(name(first));
    });

    it("finds an object by a term its own catalogue carries", async () => {
      const browsed = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { maxResults: 1 },
        })) as TextResult,
      );
      const first = (
        browsed["results"] as { schema: string; name: string }[]
      )[0];
      expect(first).toBeDefined();
      const envelope = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { query: first?.name ?? "", maxResults: 20 },
        })) as TextResult,
      );
      const found = envelope["results"] as {
        name: string;
        score: number;
        matched: { field: string; term: string; value: string }[];
      }[];
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.score).toBeGreaterThan(0);
      expect(found[0]?.matched.length).toBeGreaterThan(0);
      expect(found.some((entry) => entry.name === first?.name)).toBe(true);
    });

    it("describes a real table's columns and keys", async () => {
      const listed = body(
        (await client.callTool({
          name: "search_catalog",
          arguments: { includeViews: false, maxResults: 50 },
        })) as TextResult,
      );
      const tables = listed["results"] as { schema: string; name: string }[];
      expect(tables.length).toBeGreaterThan(0);

      let described: Record<string, unknown> | undefined;
      for (const table of tables) {
        const result = (await client.callTool({
          name: "describe_table",
          arguments: { schema: table.schema, table: table.name },
        })) as TextResult;
        if (result.isError !== true) {
          described = body(result);
          break;
        }
      }
      expect(described).toBeDefined();
      const columns = described?.["columns"] as {
        name: string;
        kind: string;
        nativeType: string;
        ordinal?: number;
      }[];
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.every((c) => c.name.length > 0)).toBe(true);
      expect(columns.every((c) => c.nativeType.length > 0)).toBe(true);
      expect(columns.some((c) => c.kind !== "unknown")).toBe(true);
      expect(Array.isArray(described?.["uniqueKeys"])).toBe(true);
      expect(Array.isArray(described?.["foreignKeys"])).toBe(true);
    });

    it("reports object_not_found for a table that is not there", async () => {
      const result = (await client.callTool({
        name: "describe_table",
        arguments: { schema: "dbo", table: "NoSuchTable_xyz_live" },
      })) as TextResult;
      expect(result.isError).toBe(true);
      expect(body(result)["error"]).toBe("object_not_found");
    });

    it("runs a read-only query and types its columns", async () => {
      const envelope = body(
        (await client.callTool({
          name: "run_query",
          arguments: {
            sql: "select cast(1 as int) as n, cast(2 as bigint) as big, 'x' as t",
          },
        })) as TextResult,
      );
      expect(envelope["rows"]).toEqual([[1, "2", "x"]]);
      const columns = envelope["columns"] as { name: string; kind: string }[];
      expect(columns.map((c) => c.kind)).toEqual(["integer", "bigint", "text"]);
    });

    it("stops at maxRows and says so", async () => {
      const envelope = body(
        (await client.callTool({
          name: "run_query",
          arguments: {
            sql: "select object_id from sys.all_objects",
            maxRows: 3,
          },
        })) as TextResult,
      );
      expect((envelope["rows"] as unknown[]).length).toBe(3);
      expect(envelope["truncated"]).toBe(true);
      expect(envelope["truncationReason"]).toBe("maxRows");
    });

    it("refuses a write before it reaches the server", async () => {
      const result = (await client.callTool({
        name: "run_query",
        arguments: { sql: "create table dbo.__live_probe (a int)" },
      })) as TextResult;
      expect(result.isError).toBe(true);
      expect(body(result)["error"]).toBe("write_not_permitted");
    });

    it("maps a real server error to a code the agent can act on", async () => {
      const result = (await client.callTool({
        name: "run_query",
        arguments: { sql: "select * from dbo.NoSuchTable_xyz_live" },
      })) as TextResult;
      expect(result.isError).toBe(true);
      const envelope = body(result);
      expect(envelope["error"]).toBe("object_not_found");
      expect(String(envelope["message"])).toContain("208");
    });

    it("serves several calls in a row on a reused pool", async () => {
      for (let round = 0; round < 3; round += 1) {
        const envelope = body(
          (await client.callTool({
            name: "run_query",
            arguments: { sql: `select ${round} as n` },
          })) as TextResult,
        );
        expect(envelope["rows"]).toEqual([[round]]);
      }
    });
  },
);
