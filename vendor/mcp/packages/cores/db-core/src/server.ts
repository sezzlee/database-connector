import type { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpSourceServer,
  type ErrorNormalizer,
  type ServerIdentity,
  type UnexpectedErrorReporter,
} from "@sezzlee/mcp-core";
import type { DbSource } from "./source.js";
import { toolDefinitions } from "./tools/definitions.js";
import { createHandlers } from "./tools/handlers.js";

export interface DbServerOptions {
  /** Where a driver error no normalizer classified is reported; stderr when absent. */
  readonly report?: UnexpectedErrorReporter;
  /**
   * Which tools refuse a principal `queryPermitted` rejects: `run_query` alone
   * (the default), or every tool that reads the database.
   *
   * Guard: a standalone server's operator may browse a schema with an
   * administrator login on purpose, so only `run_query` is gated by default.
   * A host that admits read-only logins alone passes `every_read`, so a grant
   * added after it checked the login stops the catalogue tools as well.
   */
  readonly principalGate?: "query" | "every_read";
}

/**
 * Builds the MCP server for one database source.
 *
 * Guard: `close()` is overridden to drain the connection pool first. Without it
 * a terminated process leaves open sockets holding the event loop, and the
 * server never exits.
 */
export function createDbMcpServer<TConfig>(
  identity: ServerIdentity,
  source: DbSource<TConfig>,
  normalize: ErrorNormalizer,
  options: DbServerOptions = {},
): McpServer {
  const server = createMcpSourceServer(
    identity,
    toolDefinitions,
    createHandlers(source, normalize, options),
  );
  const close = server.close.bind(server);
  server.close = async () => {
    await source.close();
    await close();
  };
  return server;
}
