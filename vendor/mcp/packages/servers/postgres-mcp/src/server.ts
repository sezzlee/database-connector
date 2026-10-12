import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  connectionSecret,
  createDbMcpServer,
  createDbSource,
  type DbServerOptions,
  type DbSource,
} from "@sezzlee/db-core";
import { createPostgresDialect } from "./dialect/index.js";
import {
  createPostgresDriver,
  type PostgresDriverOptions,
} from "./driver/adapter.js";
import { postgresConfigSchema, type PostgresConfig } from "./platform/env.js";
import { asPostgresError, fail } from "./platform/errors.js";
import { limits } from "./platform/limits.js";
import { vocabulary } from "./platform/vocabulary.js";

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function createPostgresSource(
  config: PostgresConfig,
  options: PostgresDriverOptions = {},
): DbSource<PostgresConfig> {
  const parsed = postgresConfigSchema.safeParse(config);
  if (!parsed.success)
    throw fail(
      "invalid_argument",
      "Invalid PostgreSQL connection configuration.",
    );
  return createDbSource(
    {
      dialect: createPostgresDialect(parsed.data.queryTimeoutMs),
      vocabulary,
      fail,
      limits: {
        ...limits,
        queryTimeoutMs: parsed.data.queryTimeoutMs,
        connectTimeoutMs: parsed.data.connectTimeoutMs,
      },
    },
    {
      alias: parsed.data.database,
      secret: connectionSecret(parsed.data),
      display: {
        alias: parsed.data.database,
        engine: vocabulary.engineLabel,
        catalog: parsed.data.database,
        principal: parsed.data.user,
      },
    },
    createPostgresDriver(options),
  );
}
export function createPostgresMcpServer(
  source: DbSource<PostgresConfig>,
  options: DbServerOptions = {},
): McpServer {
  return createDbMcpServer(
    { name: "sezzlee-postgres", version: manifest.version },
    source,
    asPostgresError,
    options,
  );
}
