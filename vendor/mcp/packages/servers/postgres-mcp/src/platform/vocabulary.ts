import type { DbVocabulary } from "@sezzlee/db-core";

export const vocabulary = {
  serverName: "postgres-mcp",
  subject: "database",
  listTool: "search_catalog",
  describeTool: "describe_table",
  queryTool: "run_query",
  engineLabel: "PostgreSQL",
  catalogLabel: "database",
  schemaLabel: "schema",
  objectLabel: "table",
  tooManyRowsRecovery:
    "Add ORDER BY and LIMIT with an explicit page boundary to read another page.",
  readOnlyRecovery:
    "Use a principal with SELECT privileges only. The statement guard and read-only session default do not replace database permissions.",
} as const satisfies DbVocabulary<string>;
