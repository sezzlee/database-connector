import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { sqlText } from "@sezzlee/db-core";
import { readToolCallResult } from "@chat/contracts/integration/tool-result";
import type { DatabaseRuntimeConfig } from "@chat/contracts/database/runtime";
import type { RuntimeSession } from "./pool.ts";
import { resolveConnectorTarget, resolveManagedTarget } from "./network.ts";
import { createProvider } from "./providers.ts";

export async function createRuntimeSession(
  config: DatabaseRuntimeConfig,
  password: string,
  mode: "managed" | "connector",
  signal?: AbortSignal,
): Promise<RuntimeSession> {
  const resolveSignal =
    signal === undefined
      ? AbortSignal.timeout(10000)
      : AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const target = await (
    mode === "managed" ? resolveManagedTarget : resolveConnectorTarget
  )(config.server, config.port, undefined, resolveSignal);
  signal?.throwIfAborted();
  const { source, server, probeSql, discoverySql } = createProvider(
    config,
    password,
    target,
  );
  const client = new Client({
    name: "sezzlee-database-runtime",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await server.close();
    throw error;
  }
  const query = async (sql: string, maxRows: number, signal?: AbortSignal) =>
    (
      await source.runner.run(
        {
          sql: sqlText(sql),
          parameters: [],
          timeoutMs: config.queryTimeoutMs,
          maxRows,
        },
        signal,
      )
    ).rows;
  return {
    listTools: async (signal) =>
      (
        await client.listTools(
          {},
          { ...(signal === undefined ? {} : { signal }) },
        )
      ).tools,
    callTool: async (name, args, signal) => {
      const raw = await client.callTool(
        { name, arguments: args },
        {
          ...(signal === undefined ? {} : { signal }),
          timeout: config.connectTimeoutMs + config.queryTimeoutMs + 5000,
        },
      );
      const result = readToolCallResult(raw);
      if (result === undefined) throw new Error("invalid_operation");
      if (name === "describe_connection") {
        /* Guard: SQL principal names are part of the encrypted connection credentials. */
        const structuredContent =
          result.structuredContent === undefined
            ? undefined
            : { ...result.structuredContent, principal: null };
        const blocks = result.blocks.map((block) => {
          if (block.type !== "text") return block;
          try {
            const content: unknown = JSON.parse(block.text);
            if (
              content !== null &&
              typeof content === "object" &&
              "principal" in content
            )
              return {
                ...block,
                text: JSON.stringify({ ...content, principal: null }),
              };
          } catch {
            /* Tool prose contains no connection configuration. */
          }
          return block;
        });
        return { ...result, blocks, structuredContent };
      }
      return result;
    },
    probe: async (signal) => {
      await query(probeSql, 1, signal);
      let metadata: "readable" | "unavailable" | "unknown" = "unknown";
      try {
        const result = readToolCallResult(
          await client.callTool(
            { name: "search_catalog", arguments: { maxResults: 1 } },
            {
              ...(signal === undefined ? {} : { signal }),
              timeout: config.connectTimeoutMs + config.queryTimeoutMs + 5000,
            },
          ),
        );
        if (result !== undefined)
          metadata = result.isError ? "unavailable" : "readable";
      } catch {
        signal?.throwIfAborted();
      }
      return {
        metadata,
        readOnly:
          source.sessionIntent === "read_only"
            ? ("session" as const)
            : ("principal_required" as const),
        principal: await source.principal(signal),
      };
    },
    discoverDatabases: async (signal) =>
      (await query(discoverySql, 10000, signal)).flatMap((row) =>
        typeof row[0] === "string" ? [row[0]] : [],
      ),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
