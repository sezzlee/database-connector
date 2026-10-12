import { McpServer } from "@modelcontextprotocol/server";
import type { ToolCallback } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod";
import { mcpCoreLimits } from "./limits.js";
import { toToolError } from "./tools.js";
import type {
  HandlersOf,
  ToolCatalog,
  ToolDefinitions,
  ToolNameOf,
} from "./tools.js";

type NoOutputSchema = never;

type SdkInputSchema = ToolCatalog[string]["inputSchema"];

export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
}

export function toolNamesOf<D extends ToolCatalog>(
  definitions: D,
): readonly ToolNameOf<D>[] {
  return Object.keys(definitions) as ToolNameOf<D>[];
}

/**
 * Guard: a source server's catalogue is fixed at build time and identical for every caller, so
 * both cacheable list results are `public`. Without a hint the SDK emits the conservative
 * `ttlMs: 0, cacheScope: "private"` on the 2026-07-28 revision, which makes every agent turn re-read
 * a tool list that cannot have changed. 2025-era responses never carry these fields.
 */
const catalogCacheHints = {
  "tools/list": { ttlMs: mcpCoreLimits.catalogTtlMs, cacheScope: "public" },
  "server/discover": {
    ttlMs: mcpCoreLimits.catalogTtlMs,
    cacheScope: "public",
  },
} as const;

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * Guard: the SDK validates arguments itself and answers a failure with plain text, outside the
 * error envelope, and zod's default object drops a key it does not know. Together they let a
 * misspelt option such as `caseSensitiv` vanish while the call succeeds with the default, and give
 * the agent no `error` code when a type is wrong. So the SDK is handed a schema that publishes the
 * strict JSON Schema but passes every value through, and the strict parse happens here, where a
 * failure becomes `invalid_argument` naming the accepted arguments.
 */
function strictInput(
  name: string,
  schema: z.ZodObject,
  handler: ToolCallback<SdkInputSchema>,
): { published: SdkInputSchema; handler: ToolCallback<SdkInputSchema> } {
  const strict = schema.strict();
  const accepted = Object.keys(schema.shape);
  const published = {
    "~standard": {
      version: 1,
      vendor: "sezzlee",
      validate: (value: unknown) => ({ value }),
      jsonSchema: strict["~standard"].jsonSchema,
    },
  } as unknown as SdkInputSchema;
  const run = handler as unknown as (args: unknown, extra: unknown) => unknown;
  const checked = async (args: unknown, extra: unknown): Promise<unknown> => {
    const parsed = strict.safeParse(args ?? {});
    if (!parsed.success) {
      return toToolError({
        code: "invalid_argument",
        message: `Invalid arguments for ${name}: ${describeIssues(parsed.error.issues)}.`,
        recovery:
          accepted.length === 0
            ? `${name} takes no arguments.`
            : `Accepted arguments: ${accepted.join(", ")}.`,
      });
    }
    return run(parsed.data, extra);
  };
  return {
    published,
    handler: checked as unknown as ToolCallback<SdkInputSchema>,
  };
}

function buildServer<D extends ToolCatalog>(
  identity: ServerIdentity,
  definitions: D,
  handlers: HandlersOf<D>,
): McpServer {
  const server = new McpServer(identity, { cacheHints: catalogCacheHints });
  for (const name of toolNamesOf(definitions)) {
    const definition = definitions[name] as ToolCatalog[string];
    const input = strictInput(
      name,
      definition.inputSchema,
      handlers[name] as unknown as ToolCallback<SdkInputSchema>,
    );
    server.registerTool<NoOutputSchema, SdkInputSchema>(
      name,
      { ...definition, inputSchema: input.published },
      input.handler,
    );
  }
  return server;
}

export function createMcpSourceServer<D extends ToolDefinitions>(
  identity: ServerIdentity,
  definitions: D,
  handlers: HandlersOf<D>,
): McpServer {
  return buildServer(identity, definitions, handlers);
}

/**
 * Registers a catalogue that may mix read-only tools with tools that add to the server's own
 * output.
 *
 * Guard: this is the only way such a tool reaches a server. `createMcpSourceServer` keeps its
 * read-only constraint and `file-core` and `db-core` do not re-export this function, so a server
 * built on either of them cannot register a writing tool.
 */
export function createMcpOutputServer<D extends ToolCatalog>(
  identity: ServerIdentity,
  definitions: D,
  handlers: HandlersOf<D>,
): McpServer {
  return buildServer(identity, definitions, handlers);
}

/**
 * Serves one source server over stdio, on both the 2025 era and 2026-07-28.
 *
 * Guard: `onerror` writes to stderr because stdout is the protocol channel — a stray line there
 * corrupts the JSON-RPC stream and the client loses the session with no error to show. The signal
 * handlers exist so the pinned instance's `close()` runs on a terminated process: a source that
 * hangs a worker drain or a connection pool off it leaves them holding the event loop open
 * otherwise.
 */
export function serveMcpSourceStdio(
  factory: () => McpServer,
): StdioServerHandle {
  const handle = serveStdio(factory, {
    onerror: (error) => {
      process.stderr.write(`${error.message}\n`);
    },
  });
  const shutdown = (): void => {
    void handle.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return handle;
}
