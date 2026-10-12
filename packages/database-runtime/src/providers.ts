import { createMssqlMcpServer, createMssqlSource } from "@sezzlee/mssql-mcp";
import {
  createPostgresMcpServer,
  createPostgresSource,
} from "@sezzlee/postgres-mcp";
import type { DatabaseRuntimeConfig } from "@chat/contracts/database/runtime";
import { pinnedConnector, type PinnedTarget } from "./network.ts";

/**
 * Guard: a driver error's message and stack can carry the server, the login or
 * a value, and the managed executor's stderr is the platform's log. Only the
 * tool and the error's class leave this process.
 */
function report(tool: string, error: unknown): void {
  process.stderr.write(
    `database_tool_failed ${tool} ${error instanceof Error ? error.name : typeof error}\n`,
  );
}

/**
 * Guard: a source is saved only after its login proved read-only, so the
 * catalogue tools refuse a login that gained a grant since, as `run_query` does.
 */
const serverOptions = { report, principalGate: "every_read" } as const;

export function createProvider(
  config: DatabaseRuntimeConfig,
  password: string,
  target: PinnedTarget,
) {
  const connection = {
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.username,
    password,
    connectTimeoutMs: config.connectTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
  };
  switch (config.provider) {
    case "mssql": {
      const source = createMssqlSource(
        {
          ...connection,
          encrypt: config.encrypt,
          trustServerCertificate: config.trustServerCertificate,
        },
        { connector: pinnedConnector(target), serverName: target.hostname },
      );
      return {
        source,
        server: createMssqlMcpServer(source, serverOptions),
        probeSql: "SELECT DB_NAME() AS database_name",
        discoverySql:
          "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state = 0 ORDER BY name",
      };
    }
    case "postgresql": {
      const source = createPostgresSource(
        {
          ...connection,
          sslMode: config.sslMode,
          ...(config.caCertificate === undefined
            ? {}
            : { caCertificate: config.caCertificate }),
        },
        { host: target.address, serverName: target.hostname },
      );
      return {
        source,
        server: createPostgresMcpServer(source, serverOptions),
        probeSql: "SELECT current_database() AS database_name",
        discoverySql:
          "SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
      };
    }
  }
}
