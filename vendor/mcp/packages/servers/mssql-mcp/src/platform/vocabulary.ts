import type { DbVocabulary } from "@sezzlee/db-core";

export const vocabulary = {
  serverName: "mssql-mcp",
  subject: "database",
  listTool: "search_catalog",
  describeTool: "describe_table",
  queryTool: "run_query",
  engineLabel: "SQL Server",
  catalogLabel: "database",
  schemaLabel: "schema",
  objectLabel: "table",
  tooManyRowsRecovery:
    "Add an ORDER BY with OFFSET ... ROWS FETCH NEXT ... ROWS ONLY and read the next page yourself.",
  readOnlyRecovery:
    "Connect with a principal that holds db_datareader and nothing else; the statement guard is not a security boundary.",
} as const satisfies DbVocabulary<string>;
