import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  connectionSecret,
  createDbMcpServer,
  createDbSource,
  type DbServerOptions,
  type DbSource,
} from "@sezzlee/db-core";
import { createMssqlDialect } from "./dialect/index.js";
import { createMssqlDriver, type MssqlDriverDeps } from "./driver/adapter.js";
import { asMssqlError, fail } from "./platform/errors.js";
import { limits } from "./platform/limits.js";
import { vocabulary } from "./platform/vocabulary.js";
import type { MssqlConfig } from "./platform/env.js";

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function createMssqlSource(
  config: MssqlConfig,
  deps: MssqlDriverDeps = {},
): DbSource<MssqlConfig> {
  /**
   * Guard: the two timeouts from the environment have to reach db-core's limits
   * as well as the driver. The driver's `requestTimeout` does not interrupt a
   * running statement, so db-core's `queryTimeoutMs` is the deadline that is
   * actually enforced, and it is also what `describe_connection` reports.
   */
  const bound = {
    ...limits,
    queryTimeoutMs: config.queryTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
  };
  return createDbSource(
    {
      dialect: createMssqlDialect(config.queryTimeoutMs),
      vocabulary,
      fail,
      limits: bound,
    },
    {
      alias: config.database,
      secret: connectionSecret(config),
      display: {
        alias: config.database,
        engine: vocabulary.engineLabel,
        catalog: config.database,
        principal: config.user,
      },
    },
    createMssqlDriver(deps),
  );
}

export function createMssqlMcpServer(
  source: DbSource<MssqlConfig>,
  options: DbServerOptions = {},
): McpServer {
  return createDbMcpServer(
    { name: "sezzlee-mssql", version: manifest.version },
    source,
    asMssqlError,
    options,
  );
}
