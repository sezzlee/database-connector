import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpSourceError } from "@sezzlee/mcp-core";
import {
  connectionSecret,
  createDbMcpServer,
  createDbSource,
  dbCoreLimits,
  queryPermitted,
  toolNames,
  type DbLimits,
  type DbVocabulary,
  type QuerySpec,
} from "../src/index.js";
import {
  column,
  createFakeDialect,
  createFakeDriver,
  fail,
  rows,
  type FakeConfig,
  type Script,
} from "./fake.js";

const vocabulary: DbVocabulary<string> = {
  serverName: "probe-db",
  subject: "database",
  listTool: "search_catalog",
  describeTool: "describe_table",
  queryTool: "run_query",
  engineLabel: "Probe SQL",
  catalogLabel: "database",
  schemaLabel: "schema",
  objectLabel: "table",
  tooManyRowsRecovery: "Add your own ORDER BY with OFFSET/FETCH.",
  readOnlyRecovery: "Connect with a read-only principal.",
};

const normalize = (error: unknown): McpSourceError =>
  error instanceof McpSourceError
    ? error
    : fail("internal_error", "probe failed");

const config: FakeConfig = { host: "db.internal", password: "hunter2" };

interface TextResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

function body(result: TextResult): Record<string, unknown> {
  const first = result.content[0] as { type: string; text: string };
  return JSON.parse(first.text) as Record<string, unknown>;
}

const catalogRows: Record<string, Script> = {
  server: rows(
    [column("engineVersion", 0), column("catalog", 1), column("principal", 2)],
    [["Probe 1.0", "Sales", "mcp_reader"]],
  ),
  catalogObjects: rows(
    [
      column("schema", 0),
      column("name", 1),
      column("kind", 2),
      column("description", 3),
    ],
    [
      ["dbo", "Orders", "table", "Sipariş başlıkları"],
      ["dbo", "OrderView", "view", null],
    ],
  ),
  catalogColumns: rows(
    [
      column("schema", 0),
      column("name", 1),
      column("column", 2),
      column("ordinal", 3),
      column("description", 4),
    ],
    [
      ["dbo", "Orders", "Id", 0, null],
      ["dbo", "Orders", "CustomerNote", 1, null],
      ["dbo", "OrderView", "Id", 0, null],
    ],
  ),
  columns: rows(
    [
      column("name", 0),
      column("ordinal", 1),
      column("nativeType", 2),
      column("nullable", 3),
    ],
    [
      ["Id", 0, "int", false],
      ["Note", 1, "text", true],
    ],
  ),
  keys: rows(
    [column("name", 0), column("kind", 1), column("columns", 2)],
    [["PK_Orders", "primary", ["Id"]]],
  ),
};

function build(
  respond: (spec: QuerySpec) => Script,
  limits?: DbLimits,
  openError?: () => unknown,
) {
  const driver = createFakeDriver({
    respond,
    ...(openError === undefined ? {} : { openError }),
  });
  const source = createDbSource(
    {
      dialect: createFakeDialect(),
      vocabulary,
      fail,
      ...(limits === undefined ? {} : { limits }),
    },
    {
      alias: "sales",
      secret: connectionSecret(config),
      display: { alias: "sales", engine: "Probe SQL", catalog: "Sales" },
    },
    driver.adapter,
  );
  return { driver, source };
}

let client: Client;

async function connect(
  respond: (spec: QuerySpec) => Script,
  limits?: DbLimits,
  openError?: () => unknown,
): Promise<void> {
  const { source } = build(respond, limits, openError);
  const server = createDbMcpServer(
    { name: "probe-db", version: "9.9.9" },
    source,
    normalize,
  );
  client = new Client({ name: "db-spec", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
}

let moved = false;

const catalogOnly = (spec: QuerySpec): Script => {
  if (moved && spec.sql === "catalogObjects") {
    return rows(
      [
        column("schema", 0),
        column("name", 1),
        column("kind", 2),
        column("description", 3),
      ],
      [["dbo", "Invoices", "table", null]],
    );
  }
  return catalogRows[spec.sql] ?? rows([column("a", 0)], [["x"]]);
};

describe("the tool catalogue", () => {
  beforeEach(async () => {
    await connect(catalogOnly);
  });

  it("registers exactly the four read-only tools", async () => {
    const listed = (await client.listTools()).tools;
    expect(listed.map((tool) => tool.name).sort()).toEqual(
      [...toolNames].sort(),
    );
    expect(listed).toHaveLength(4);
  });

  /**
   * Guard: named, not derived. Comparing the catalogue against `toolNames` is
   * true whatever the names are, so a rename would pass it in silence — and the
   * whole point of this change is that one tool went away and another arrived.
   */
  it("serves search_catalog and no longer serves the listing it replaced", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("search_catalog");
    expect(names).not.toContain("list_tables");
  });

  it("carries the read-only annotations over the wire", async () => {
    const listed = (await client.listTools()).tools;
    expect(
      listed.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.openWorldHint === false,
      ),
    ).toBe(true);
  });
});

describe("describe_connection", () => {
  beforeEach(async () => {
    await connect(catalogOnly);
  });

  it("reports the engine, the catalogue and the read-only posture", async () => {
    const result = (await client.callTool({
      name: "describe_connection",
      arguments: {},
    })) as TextResult;
    const envelope = body(result);
    expect(envelope["alias"]).toBe("sales");
    expect(envelope["engineVersion"]).toBe("Probe 1.0");
    expect(envelope["catalog"]).toBe("Sales");
    expect(envelope["readOnly"]).toMatchObject({
      sessionIntent: "none",
      statementGuard: "advisory",
    });
  });

  it("never returns anything from the connection secret", async () => {
    const result = (await client.callTool({
      name: "describe_connection",
      arguments: {},
    })) as TextResult;
    const text = JSON.stringify(body(result));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.internal");
  });
});

describe("search_catalog and describe_table", () => {
  beforeEach(async () => {
    moved = false;
    await connect(catalogOnly);
  });

  const search = async (args: Record<string, unknown>) =>
    body(
      (await client.callTool({
        name: "search_catalog",
        arguments: args,
      })) as TextResult,
    );

  it("pages the whole catalogue when the query is empty", async () => {
    const envelope = await search({});
    expect(envelope["results"]).toEqual([
      {
        schema: "dbo",
        name: "Orders",
        kind: "table",
        description: "Sipariş başlıkları",
      },
      { schema: "dbo", name: "OrderView", kind: "view" },
    ]);
    expect(envelope["complete"]).toBe(true);
    expect(envelope["nextCursor"]).toBeUndefined();
  });

  it("reports a whole index as complete, with no coverage hint", async () => {
    const facts = (await search({}))["catalog"] as Record<string, unknown>;
    expect(facts["complete"]).toBe(true);
    expect(facts["indexedObjects"]).toBe(2);
    expect(facts["coverageEndsAt"]).toBeUndefined();
    expect(typeof facts["indexedAt"]).toBe("string");
  });

  it("keeps the filters the listing it replaces carried", async () => {
    expect((await search({ includeViews: false }))["returnedCount"]).toBe(1);
    expect((await search({ namePattern: "Order_View" }))["returnedCount"]).toBe(
      0,
    );
    expect((await search({ namePattern: "Order____" }))["returnedCount"]).toBe(
      1,
    );
    expect((await search({ namePattern: "Order%" }))["returnedCount"]).toBe(2);
    expect((await search({ schema: "nosuch" }))["returnedCount"]).toBe(0);
  });

  it("finds an object through a column name it never showed before", async () => {
    const envelope = await search({ query: "customer note" });
    const first = (envelope["results"] as Record<string, unknown>[])[0];
    expect(first?.["name"]).toBe("Orders");
    expect(first?.["matched"]).toContainEqual({
      field: "column",
      term: "customernote",
      value: "CustomerNote",
    });
  });

  it("finds an object through its description, folded", async () => {
    const envelope = await search({ query: "SIPARIS" });
    const first = (envelope["results"] as Record<string, unknown>[])[0];
    expect((envelope["results"] as unknown[]).length).toBe(1);
    expect(first?.["matched"]).toContainEqual({
      field: "description",
      term: "siparis",
      value: "Sipariş başlıkları",
    });
    expect(first?.["description"]).toBe("Sipariş başlıkları");
  });

  /**
   * Guard: the cursor resumes after the last object actually sent. A cursor
   * built from the requested page size drops whatever the byte budget refused,
   * and nothing in the envelope would say a row went missing.
   */
  it("walks the pages without repeating or skipping an object", async () => {
    const first = await search({ maxResults: 1 });
    expect(first["returnedCount"]).toBe(1);
    expect(first["truncated"]).toBe(true);
    expect(first["truncationReason"]).toBe("maxResults");

    const second = await search({
      maxResults: 1,
      cursor: first["nextCursor"] as string,
    });
    expect(second["complete"]).toBe(true);
    expect(second["nextCursor"]).toBeUndefined();

    const names = [
      ...(first["results"] as Record<string, unknown>[]),
      ...(second["results"] as Record<string, unknown>[]),
    ].map((entry) => entry["name"]);
    expect(names).toEqual(["Orders", "OrderView"]);
  });

  it("refuses a cursor that is not one it issued", async () => {
    const envelope = await search({ cursor: "not-a-cursor" });
    expect(envelope["error"]).toBe("invalid_cursor");
  });

  it("refuses a cursor issued against a different question", async () => {
    const first = await search({ maxResults: 1 });
    const envelope = await search({
      maxResults: 1,
      query: "orders",
      cursor: first["nextCursor"] as string,
    });
    expect(envelope["error"]).toBe("stale_cursor");
  });

  /**
   * Guard: a cursor points into a list that no longer exists once the catalogue
   * was read again. Resuming at position 1 of a different catalogue returns a
   * neighbouring object as though it were the next page.
   */
  it("refuses a cursor issued before the catalogue was read again", async () => {
    const first = await search({ maxResults: 1 });
    moved = true;
    const envelope = await search({
      maxResults: 1,
      refresh: true,
      cursor: first["nextCursor"] as string,
    });
    expect(envelope["error"]).toBe("stale_cursor");
  });

  it("says nothing was found without claiming the catalogue is empty", async () => {
    const envelope = await search({ query: "zzzznosuchterm" });
    expect(envelope["results"]).toEqual([]);
    expect((envelope["catalog"] as Record<string, unknown>)["complete"]).toBe(
      true,
    );
    expect(envelope["hint"]).toBeUndefined();
  });
});

/**
 * Guard: a partial index is the dangerous shape, not the truncated page. A cut
 * listing still looks partial; an empty search result reads as "it does not
 * exist". These tests pin the difference.
 */
describe("a catalogue the index could not read whole", () => {
  const partial: Record<string, Script> = {
    server: catalogRows["server"] as Script,
    catalogObjects: rows(
      [column("schema", 0), column("name", 1), column("kind", 2)],
      [
        ["dbo", "AInvoices", "table"],
        ["dbo", "BLedger", "table"],
        ["dbo", "CVendors", "table"],
      ],
    ),
    catalogColumns: rows(
      [
        column("schema", 0),
        column("name", 1),
        column("column", 2),
        column("ordinal", 3),
      ],
      [
        ["dbo", "AInvoices", "InvoiceNo", 0],
        ["dbo", "BLedger", "LedgerNo", 0],
        ["dbo", "BLedger", "Amount", 1],
        ["dbo", "CVendors", "VendorName", 0],
      ],
    ),
  };

  beforeEach(async () => {
    await connect(
      (spec) => partial[spec.sql] ?? rows([column("a", 0)], [["x"]]),
      { ...dbCoreLimits, maxIndexRows: 3 },
    );
  });

  const search = async (args: Record<string, unknown>) =>
    body(
      (await client.callTool({
        name: "search_catalog",
        arguments: args,
      })) as TextResult,
    );

  it("drops the object whose columns the read cut, rather than half-indexing it", async () => {
    const facts = (await search({}))["catalog"] as Record<string, unknown>;
    expect(facts["complete"]).toBe(false);
    expect(facts["indexedObjects"]).toBe(1);
    expect(facts["coverageEndsAt"]).toBe("dbo.AInvoices");
  });

  it("keeps the object it did read whole", async () => {
    const envelope = await search({ query: "invoiceno" });
    expect((envelope["results"] as unknown[]).length).toBe(1);
  });

  it("does not let an unread name read as a name that does not exist", async () => {
    const envelope = await search({ query: "vendorname" });
    expect(envelope["results"]).toEqual([]);
    expect((envelope["catalog"] as Record<string, unknown>)["complete"]).toBe(
      false,
    );
    expect(String(envelope["hint"])).toContain("dbo.AInvoices");
  });

  /**
   * Guard: a column of an object inside the boundary but read past the cut must
   * not be searchable either. Half an object is what makes the agent see one
   * world in one query and a different one in the next.
   */
  it("indexes no column of the object it dropped", async () => {
    expect((await search({ query: "amount" }))["results"]).toEqual([]);
    expect((await search({ query: "ledgerno" }))["results"]).toEqual([]);
  });
});

/**
 * Guard: the column read is not scoped to the object prefix, so when both reads
 * are cut the column cut can land past the last object read. The boundary is
 * then the object cut, not a failure.
 */
describe("a catalogue both reads cut, the column read further", () => {
  const cut: Record<string, Script> = {
    server: catalogRows["server"] as Script,
    catalogObjects: rows(
      [column("schema", 0), column("name", 1), column("kind", 2)],
      [
        ["dbo", "AInvoices", "table"],
        ["dbo", "BLedger", "table"],
        ["dbo", "CVendors", "table"],
        ["dbo", "DOrders", "table"],
      ],
    ),
    catalogColumns: rows(
      [
        column("schema", 0),
        column("name", 1),
        column("column", 2),
        column("ordinal", 3),
      ],
      [
        ["dbo", "AInvoices", "InvoiceNo", 0],
        ["dbo", "BLedger", "LedgerNo", 0],
        ["dbo", "CVendors", "VendorName", 0],
        ["dbo", "DOrders", "OrderNo", 0],
        ["dbo", "DOrders", "Total", 1],
      ],
    ),
  };

  beforeEach(async () => {
    await connect((spec) => cut[spec.sql] ?? rows([column("a", 0)], [["x"]]), {
      ...dbCoreLimits,
      maxIndexObjects: 2,
      maxIndexRows: 4,
    });
  });

  it("indexes the object prefix instead of refusing the search", async () => {
    const envelope = body(
      (await client.callTool({
        name: "search_catalog",
        arguments: { query: "ledgerno" },
      })) as TextResult,
    );
    const facts = envelope["catalog"] as Record<string, unknown>;
    expect(envelope["error"]).toBeUndefined();
    expect(facts["complete"]).toBe(false);
    expect(facts["indexedObjects"]).toBe(2);
    expect(facts["coverageEndsAt"]).toBe("dbo.BLedger");
    expect((envelope["results"] as unknown[]).length).toBe(1);
  });
});

describe("describe_table", () => {
  beforeEach(async () => {
    await connect(catalogOnly);
  });

  it("returns columns and the primary key", async () => {
    const result = (await client.callTool({
      name: "describe_table",
      arguments: { schema: "dbo", table: "Orders" },
    })) as TextResult;
    const envelope = body(result);
    expect(envelope["primaryKey"]).toEqual(["Id"]);
    expect(envelope["columns"]).toHaveLength(2);
  });

  /**
   * Guard: the driver reads one past `maxColumns`, so the refusal fires on a
   * table it cannot describe whole. Sharing one row cap across every
   * introspection question let the driver cut the list below the limit that
   * would have refused it, and the table came back silently short.
   */
  it("refuses a table whose column list the engine had to cut", async () => {
    const many = Array.from({ length: dbCoreLimits.maxColumns + 1 }, (_, i) => [
      `c${String(i)}`,
      i,
      "text",
      true,
    ]);
    await connect((spec) =>
      spec.sql === "columns"
        ? rows(
            [
              column("name", 0),
              column("ordinal", 1, "integer"),
              column("nativeType", 2),
              column("nullable", 3, "boolean"),
            ],
            many,
          )
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "describe_table",
      arguments: { schema: "dbo", table: "Wide" },
    })) as TextResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(body(result))).toContain("resource_limit");
  });

  /**
   * Guard: a foreign key the agent never sees is a join it writes wrong, with
   * no error anywhere to show for it. Keys are supplementary so the list is cut
   * rather than refused, but the cut has to reach the envelope.
   */
  it("reports a cut key list instead of passing it off as the whole one", async () => {
    const many = Array.from({ length: dbCoreLimits.maxKeys + 1 }, (_, i) => [
      `fk${String(i)}`,
      "foreign",
      ["a"],
      "dbo",
      "Other",
      ["b"],
    ]);
    await connect((spec) =>
      spec.sql === "keys"
        ? rows(
            [
              column("name", 0),
              column("kind", 1),
              column("columns", 2),
              column("referencedSchema", 3),
              column("referencedTable", 4),
              column("referencedColumns", 5),
            ],
            many,
          )
        : catalogOnly(spec),
    );
    const envelope = body(
      (await client.callTool({
        name: "describe_table",
        arguments: { schema: "dbo", table: "Hub" },
      })) as TextResult,
    );
    expect(envelope["keysComplete"]).toBe(false);
    expect(envelope["truncationReason"]).toBe("maxKeys");
    expect((envelope["foreignKeys"] as unknown[]).length).toBe(
      dbCoreLimits.maxKeys,
    );
  });

  it("reports object_not_found and points at the list tool", async () => {
    await connect((spec) =>
      spec.sql === "columns" ? rows([], []) : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "describe_table",
      arguments: { schema: "dbo", table: "Missing" },
    })) as TextResult;
    expect(result.isError).toBe(true);
    const envelope = body(result);
    expect(envelope["error"]).toBe("object_not_found");
    expect(String(envelope["recovery"])).toContain("search_catalog");
  });
});

describe("run_query", () => {
  it("returns the rows a select produced", async () => {
    await connect((spec) =>
      spec.sql === "select 1"
        ? rows([column("n", 0, "integer")], [[1], [2]])
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select 1" },
    })) as TextResult;
    const envelope = body(result);
    expect(envelope["rows"]).toEqual([[1], [2]]);
    expect(envelope["complete"]).toBe(true);
  });

  it("hands a driver error no normalizer classified to the server's reporter", async () => {
    const thrown = new Error("socket to db.internal:1433 as reader closed");
    const { source } = build(catalogOnly, undefined, () => thrown);
    const report = vi.fn();
    const server = createDbMcpServer(
      { name: "probe-db", version: "9.9.9" },
      source,
      normalize,
      { report },
    );
    const local = new Client({ name: "db-spec", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([local.connect(a), server.connect(b)]);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const result = (await local.callTool({
      name: "run_query",
      arguments: { sql: "select 1" },
    })) as TextResult;
    const written = stderr.mock.calls.length;
    stderr.mockRestore();

    expect(result.isError).toBe(true);
    expect(report).toHaveBeenCalledWith("run_query", thrown);
    expect(written).toBe(0);
  });

  it("refuses a write through the dialect guard, before any connection is used", async () => {
    const { source } = build(catalogOnly);
    const server = createDbMcpServer(
      { name: "probe-db", version: "9.9.9" },
      source,
      normalize,
    );
    const local = new Client({ name: "db-spec", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([local.connect(a), server.connect(b)]);
    const result = (await local.callTool({
      name: "run_query",
      arguments: { sql: "delete from Orders" },
    })) as TextResult;
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("write_not_permitted");
  });

  it.each(["writable", "administrator"])(
    "refuses every statement while the principal is %s on a session that is not read-only",
    async (posture) => {
      const { driver, source } = build((spec) =>
        spec.sql === "principal"
          ? rows([column("posture", 0)], [[posture]])
          : catalogOnly(spec),
      );
      const server = createDbMcpServer(
        { name: "probe-db", version: "9.9.9" },
        source,
        normalize,
      );
      const local = new Client({ name: "db-spec", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([local.connect(a), server.connect(b)]);
      const result = (await local.callTool({
        name: "run_query",
        arguments: { sql: "select 1" },
      })) as TextResult;
      expect(result.isError).toBe(true);
      expect(body(result)["error"]).toBe("write_not_permitted");
      expect(driver.stats.ran.map((spec) => spec.sql)).not.toContain(
        "select 1",
      );
    },
  );

  it.each([
    [undefined, false],
    ["every_read", true],
  ] as const)(
    "with the principal gate %s, refuses the catalogue tools to a writable principal: %s",
    async (principalGate, refused) => {
      const { source } = build((spec) =>
        spec.sql === "principal"
          ? rows([column("posture", 0)], [["writable"]])
          : catalogOnly(spec),
      );
      const server = createDbMcpServer(
        { name: "probe-db", version: "9.9.9" },
        source,
        normalize,
        principalGate === undefined ? {} : { principalGate },
      );
      const local = new Client({ name: "db-spec", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([local.connect(a), server.connect(b)]);

      for (const [name, args] of [
        ["search_catalog", { query: "Orders" }],
        ["describe_table", { schema: "dbo", table: "Orders" }],
      ] as const) {
        const result = (await local.callTool({
          name,
          arguments: args,
        })) as TextResult;
        expect(
          result.isError === true &&
            body(result)["error"] === "write_not_permitted",
        ).toBe(refused);
      }
    },
  );

  it("marks the page truncated when the driver stopped at maxRows", async () => {
    await connect((spec) =>
      spec.sql === "select 1"
        ? rows([column("n", 0, "integer")], [[1]], true)
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select 1", maxRows: 1 },
    })) as TextResult;
    const envelope = body(result);
    expect(envelope["truncated"]).toBe(true);
    expect(envelope["truncationReason"]).toBe("maxRows");
    expect(String(envelope["hint"])).toContain("OFFSET");
  });

  it("stops admitting rows at the payload budget and stays inside it", async () => {
    const wide = Array.from({ length: dbCoreLimits.maxRows }, () => [
      "x".repeat(dbCoreLimits.maxTextChars),
    ]);
    await connect((spec) =>
      spec.sql === "select 1"
        ? rows([column("blob", 0)], wide)
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select 1", maxRows: dbCoreLimits.maxRows },
    })) as TextResult;
    const first = result.content[0] as { text: string };
    const envelope = body(result);
    expect(envelope["truncated"]).toBe(true);
    expect(envelope["truncationReason"]).toBe("maxPayloadBytes");
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(
      dbCoreLimits.maxPayloadBytes,
    );
  });

  it("publishes precision and scale for an exact numeric and for nothing else", async () => {
    await connect((spec) =>
      spec.sql === "select amount, id from ledger"
        ? rows(
            [
              {
                ...column("amount", 0, "decimal"),
                precision: 38,
                scale: 4,
                lossy: "precision",
              },
              { ...column("id", 1, "integer"), precision: 10, scale: 0 },
            ],
            [[12.5, 1]],
          )
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select amount, id from ledger" },
    })) as TextResult;
    const [amount, id] = body(result)["columns"] as Record<string, unknown>[];
    expect(amount).toMatchObject({
      precision: 38,
      scale: 4,
      lossy: "precision",
    });
    expect(id).not.toHaveProperty("precision");
    expect(id).not.toHaveProperty("scale");
  });

  it("classifies a driver failure through the dialect and redacts the secret", async () => {
    await connect((spec) =>
      spec.sql === "select 1"
        ? {
            kind: "throw",
            error: new Error("login failed for mssql://sa:hunter2@db.internal"),
          }
        : catalogOnly(spec),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select 1" },
    })) as TextResult;
    expect(result.isError).toBe(true);
    const envelope = body(result);
    expect(envelope["error"]).toBe("authentication_failed");
    expect(String(envelope["message"])).toContain("18456");
    expect(JSON.stringify(envelope)).not.toContain("hunter2");
  });

  it("classifies a failure to open the connection through the dialect", async () => {
    await connect(
      catalogOnly,
      undefined,
      () => new Error("login failed for mssql://sa:hunter2@db.internal"),
    );
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "select 1" },
    })) as TextResult;
    const envelope = body(result);
    expect(envelope["error"]).toBe("authentication_failed");
    expect(JSON.stringify(envelope)).not.toContain("hunter2");
  });

  it("refuses arguments the schema does not accept before the handler runs", async () => {
    await connect(catalogOnly);
    const result = (await client.callTool({
      name: "run_query",
      arguments: { sql: "" },
    })) as TextResult;
    expect(result.isError).toBe(true);
  });
});

describe("queryPermitted", () => {
  it.each([
    ["read_only", "none", true],
    ["read_only", "read_only", true],
    ["writable", "read_only", true],
    ["writable", "none", false],
    ["administrator", "read_only", false],
    ["administrator", "none", false],
    ["unknown", "read_only", false],
    ["unknown", "none", false],
  ] as const)(
    "a %s principal on a %s session may query: %s",
    (posture, sessionIntent, permitted) => {
      expect(queryPermitted(posture, sessionIntent)).toBe(permitted);
    },
  );
});
