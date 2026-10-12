import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  McpSourceError,
  type ErrorFactory,
  type SourceErrorCode,
} from "../src/errors.js";
import { createMcpOutputServer, createMcpSourceServer } from "../src/server.js";
import {
  guard,
  json,
  ownOutput,
  readOnly,
  type HandlersOf,
  type ToolCatalog,
  type ToolDefinitions,
  type ToolInputOf,
} from "../src/tools.js";

const fail: ErrorFactory<SourceErrorCode> = (code, message, recovery) =>
  new McpSourceError(code, message, recovery);

const normalize = (error: unknown): McpSourceError =>
  error instanceof McpSourceError ? error : fail("internal_error", "boom");

const definitions = {
  list_notes: {
    description: "List the notes.",
    inputSchema: z.object({ pattern: z.string().optional() }),
    annotations: readOnly,
  },
  label_notes: {
    description: "Label every note and keep the result as a new output.",
    inputSchema: z.object({ instruction: z.string(), size: z.number() }),
    annotations: ownOutput,
  },
} as const satisfies ToolCatalog;

type Definitions = typeof definitions;

const handlers: HandlersOf<Definitions> = {
  list_notes: guard<Definitions, "list_notes">(
    { tool: "list_notes", fail },
    async (args) => json({ pattern: args.pattern ?? "*" }),
    normalize,
  ),
  label_notes: guard<Definitions, "label_notes">(
    { tool: "label_notes", fail },
    async (args) => json({ output: "x".repeat(args.size) }),
    normalize,
  ),
};

const identity = { name: "probe-mcp", version: "9.9.9" };

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("the tool returned no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("the own-output tool type", () => {
  it("is refused wherever a read-only catalogue is required", () => {
    const writing = { label_notes: definitions.label_notes };
    expectTypeOf(writing).not.toExtend<ToolDefinitions>();
    expectTypeOf<Definitions>().not.toExtend<
      Parameters<typeof createMcpSourceServer>[1]
    >();
    expectTypeOf<Definitions>().toExtend<
      Parameters<typeof createMcpOutputServer>[1]
    >();
  });

  it("must declare itself non-destructive", () => {
    const shape = { description: "", inputSchema: z.object({}) };
    const destructive = {
      wipe: {
        ...shape,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    } as const;
    const silent = {
      wipe: { ...shape, annotations: { readOnlyHint: false } },
    } as const;
    expectTypeOf(destructive).not.toExtend<ToolCatalog>();
    expectTypeOf(silent).not.toExtend<ToolCatalog>();
    expectTypeOf<ToolDefinitions>().toExtend<ToolCatalog>();
  });

  it("infers each tool's input across a mixed catalogue", () => {
    expectTypeOf<ToolInputOf<Definitions, "label_notes">>().toEqualTypeOf<{
      instruction: string;
      size: number;
    }>();
    expectTypeOf<ToolInputOf<Definitions, "list_notes">>().toEqualTypeOf<{
      pattern?: string | undefined;
    }>();
  });
});

describe("createMcpOutputServer", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createMcpOutputServer(identity, definitions, handlers);
    client = new Client({ name: "output-spec", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  it("carries each tool's own annotations over the wire", async () => {
    const listed = (await client.listTools()).tools;
    const hints = Object.fromEntries(
      listed.map((tool) => [tool.name, tool.annotations]),
    );
    expect(hints["list_notes"]).toMatchObject(readOnly);
    expect(hints["label_notes"]).toMatchObject(ownOutput);
  });

  it("passes validated arguments through to a writing tool", async () => {
    const result = (await client.callTool({
      name: "label_notes",
      arguments: { instruction: "tag", size: 3 },
    })) as CallToolResult;
    expect(body(result)).toEqual({ output: "xxx" });
  });

  it("holds a writing tool to the same payload budget", async () => {
    const result = (await client.callTool({
      name: "label_notes",
      arguments: { instruction: "tag", size: 600_000 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("resource_limit");
  });
});
