import {
  readOnly,
  toolNamesOf,
  type HandlersOf,
  type ToolDefinitions,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/mcp-core";
import { z } from "zod";
import { dbCoreLimits } from "../limits.js";

const identifier = z.string().min(1).max(256);

export const toolDefinitions = {
  describe_connection: {
    description:
      "Report which database this server is connected to, what the connection may do, and the limits every other tool is bound by. Takes no arguments and never returns credentials.",
    inputSchema: z.object({}),
    annotations: readOnly,
  },
  search_catalog: {
    description:
      "Find the tables and views this connection can read by concept rather than by exact name: the query is matched against schema, object and column names and against whatever descriptions the catalogue carries, and each result says which of them matched. Leave query empty to page through the catalogue instead. Start here \u2014 the names it returns are the ones describe_table and run_query accept.",
    inputSchema: z.object({
      query: z
        .string()
        .max(256)
        .optional()
        .describe(
          "Words describing what you are looking for, such as customer orders. Matched against names and descriptions, ignoring case and accents. Omit to list every object.",
        ),
      schema: identifier
        .optional()
        .describe("Keep only objects in this schema. Case-insensitive."),
      namePattern: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "Keep only objects whose name matches this LIKE pattern: % stands for any run of characters and _ for one. Case- and accent-insensitive.",
        ),
      includeViews: z
        .boolean()
        .optional()
        .describe("Include views as well as tables, default true."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(dbCoreLimits.maxListResults)
        .optional()
        .describe(
          `Maximum objects returned, default ${dbCoreLimits.defaultListResults}.`,
        ),
      cursor: z
        .string()
        .min(1)
        .max(16_384)
        .optional()
        .describe(
          "nextCursor from a previous search with the same query, schema, namePattern and includeViews, to continue its results.",
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Read the catalogue again instead of using the cached copy, default false. Use it after a schema change; it invalidates earlier cursors.",
        ),
    }),
    annotations: readOnly,
  },
  describe_table: {
    description:
      "Report one table's columns with their types and nullability, plus its primary, unique and foreign keys. Read this before writing a query against the table.",
    inputSchema: z.object({
      schema: identifier.describe(
        "Schema of the table, as search_catalog returned it.",
      ),
      table: identifier.describe(
        "Name of the table or view, as search_catalog returned it.",
      ),
    }),
    annotations: readOnly,
  },
  run_query: {
    description:
      "Run one read-only SQL statement and return its rows. Writes are refused. The response is capped and there is no cursor, so walk a large result by adding your own ordering and paging clause; a truncated response says which clause this engine uses.",
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .max(20_000)
        .describe(
          "One read-only statement in this engine's SQL dialect. A statement that writes, or more than one statement, is refused.",
        ),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(dbCoreLimits.maxRows)
        .optional()
        .describe(
          "Maximum rows returned. Defaults to defaultRows from describe_connection. A longer result is cut and says so.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(600_000)
        .optional()
        .describe(
          "Deadline for the statement in milliseconds; the server cancels it when the deadline passes. Defaults to queryTimeoutMs from describe_connection.",
        ),
    }),
    annotations: readOnly,
  },
} as const satisfies ToolDefinitions;

export type Definitions = typeof toolDefinitions;
export type ToolName = ToolNameOf<Definitions>;
export const toolNames: readonly ToolName[] = toolNamesOf(toolDefinitions);
export type ToolInput<K extends ToolName> = ToolInputOf<Definitions, K>;
export type ToolHandlers = HandlersOf<Definitions>;
