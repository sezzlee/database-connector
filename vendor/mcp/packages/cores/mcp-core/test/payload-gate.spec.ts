import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpSourceServer } from "../src/server.js";
import {
  McpSourceError,
  type ErrorFactory,
  type SourceErrorCode,
} from "../src/errors.js";
import { measureJson } from "../src/payload.js";
import {
  guard,
  json,
  readOnly,
  toToolError,
  type ToolDefinitions,
} from "../src/tools.js";

const fail: ErrorFactory<SourceErrorCode> = (code, message, recovery) =>
  new McpSourceError(code, message, recovery);

const definitions = {
  big_document: {
    description: "Return an oversized payload.",
    inputSchema: z.object({}),
    annotations: readOnly,
  },
} as const satisfies ToolDefinitions;

type Definitions = typeof definitions;

const normalize = (error: unknown): McpSourceError =>
  error instanceof McpSourceError ? error : fail("internal_error", "boom");

interface TextResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

function envelopeOf(result: TextResult): Record<string, string> {
  const first = result.content[0] as { type: string; text: string };
  return JSON.parse(first.text) as Record<string, string>;
}

function textBytes(result: TextResult): number {
  const first = result.content[0] as { type: string; text: string };
  return Buffer.byteLength(first.text, "utf8");
}

describe("toToolError under a byte budget", () => {
  it("keeps a small envelope untouched", () => {
    const result = toToolError(
      fail("invalid_argument", "No such document.", "Call list_documents."),
      {},
    );
    expect(envelopeOf(result)).toEqual({
      error: "invalid_argument",
      message: "No such document.",
      recovery: "Call list_documents.",
    });
  });

  it("clamps a pathological message under the limit", () => {
    const result = toToolError(
      fail("internal_error", '"'.repeat(500_000)),
      {},
      1_024,
    );
    expect(textBytes(result)).toBeLessThanOrEqual(1_024);
    expect(envelopeOf(result)["error"]).toBe("internal_error");
  });

  it("runs the injected redactor over the message and the recovery", () => {
    const result = toToolError(
      fail("internal_error", "the secret is here", "drop the secret"),
      { redact: (detail) => detail.replaceAll("secret", "[redacted]") },
    );
    expect(envelopeOf(result)).toEqual({
      error: "internal_error",
      message: "the [redacted] is here",
      recovery: "drop the [redacted]",
    });
  });

  it("clamps after redaction, never before", () => {
    const result = toToolError(
      fail("internal_error", `${"a".repeat(400)} secret`),
      { redact: (detail) => detail.replaceAll("secret", "") },
      64,
    );
    expect(envelopeOf(result)["message"]).not.toContain("secret");
    expect(textBytes(result)).toBeLessThanOrEqual(64);
  });

  it("drops recovery only when an empty message still does not fit", () => {
    const budget = measureJson({ error: "resource_limit", message: "" }) + 4;
    const result = toToolError(
      fail("resource_limit", "a".repeat(400), "b".repeat(400)),
      {},
      budget,
    );
    expect(envelopeOf(result)["recovery"]).toBeUndefined();
    expect(textBytes(result)).toBeLessThanOrEqual(budget);
  });

  it("lets the structural floor win over an impossible budget", () => {
    const result = toToolError(fail("internal_error", "boom", "retry"), {}, 5);
    expect(envelopeOf(result)).toEqual({
      error: "internal_error",
      message: "",
    });
    expect(textBytes(result)).toBe(39);
  });

  it("never throws, whatever it is handed", () => {
    const messages = ["", "\ud83d", "ctrl", "s".repeat(300)];
    const codes: SourceErrorCode[] = ["internal_error", "resource_limit"];
    for (const code of codes) {
      for (const maxBytes of [-1, 0, 1, 39, 40, 4_096]) {
        for (const message of messages) {
          const result = toToolError(
            fail(code, message, message),
            {},
            maxBytes,
          );
          expect(() => envelopeOf(result)).not.toThrow();
        }
      }
    }
  });
});

describe("the guard payload gate", () => {
  const gated = (body: unknown, maxBytes?: number) =>
    guard<Definitions, "big_document">(
      {
        tool: "big_document",
        fail,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
      async () => json(body),
      normalize,
    );

  it("turns an oversized success into a bounded resource_limit", async () => {
    const result = await gated({ blob: "x".repeat(600_000) })({});
    expect(result.isError).toBe(true);
    const envelope = envelopeOf(result);
    expect(envelope["error"]).toBe("resource_limit");
    expect(envelope["message"]).toContain("big_document");
    expect(textBytes(result)).toBeLessThanOrEqual(512 * 1024);
  });

  it("honours a tighter budget from the guard context", async () => {
    const result = await gated({ blob: "x".repeat(100) }, 64)({});
    expect(envelopeOf(result)["error"]).toBe("resource_limit");
    expect(textBytes(result)).toBeLessThanOrEqual(64);
  });

  it("lets a payload inside the budget through untouched", async () => {
    const result = await gated({ ok: true })({});
    expect(result.isError).toBeUndefined();
    expect(envelopeOf(result)).toEqual({ ok: true });
  });
});

describe("the gate over a real transport", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createMcpSourceServer(
      { name: "probe-mcp", version: "9.9.9" },
      definitions,
      {
        big_document: guard<Definitions, "big_document">(
          { tool: "big_document", fail },
          async () => json({ blob: "x".repeat(600_000) }),
          normalize,
        ),
      },
    );
    client = new Client({ name: "budget-spec", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  it("reports a bounded resource_limit instead of an oversized success", async () => {
    const result = (await client.callTool({
      name: "big_document",
      arguments: {},
    })) as TextResult;
    expect(result.isError).toBe(true);
    expect(envelopeOf(result)["error"]).toBe("resource_limit");
    expect(textBytes(result)).toBeLessThanOrEqual(512 * 1024);
  });
});
