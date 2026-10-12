#!/usr/bin/env node
import { serveMcpSourceStdio } from "@sezzlee/db-core";
import { readMssqlEnv, requiredNames } from "./platform/env.js";
import { createMssqlMcpServer, createMssqlSource } from "./server.js";

function stop(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Guard: every variable is named explicitly instead of handing the whole
 * environment to the parser. `turbo/no-undeclared-env-vars` only sees a named
 * access, and that is what forces each one into this package's `passThroughEnv`
 * — the lint rule is what keeps the documented env surface honest.
 */
const outcome = readMssqlEnv({
  SEZZLEE_MSSQL_SERVER: process.env["SEZZLEE_MSSQL_SERVER"],
  SEZZLEE_MSSQL_PORT: process.env["SEZZLEE_MSSQL_PORT"],
  SEZZLEE_MSSQL_DATABASE: process.env["SEZZLEE_MSSQL_DATABASE"],
  SEZZLEE_MSSQL_USER: process.env["SEZZLEE_MSSQL_USER"],
  SEZZLEE_MSSQL_PASSWORD: process.env["SEZZLEE_MSSQL_PASSWORD"],
  SEZZLEE_MSSQL_ENCRYPT: process.env["SEZZLEE_MSSQL_ENCRYPT"],
  SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE:
    process.env["SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE"],
  SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS:
    process.env["SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS"],
  SEZZLEE_MSSQL_QUERY_TIMEOUT_MS: process.env["SEZZLEE_MSSQL_QUERY_TIMEOUT_MS"],
});

if (outcome.kind === "usage") {
  stop(
    `sezzlee-mssql reads its connection from the environment. Missing: ${outcome.missing.join(", ")}.\nRequired: ${requiredNames.join(", ")}.`,
    2,
  );
}

if (outcome.kind === "invalid") {
  stop(outcome.reason, 2);
}

/**
 * Guard: parsing is fatal here, connecting is not. The server has to start and
 * answer `tools/list` with the database unreachable, which is also what lets a
 * packaged install be smoke-tested without one.
 */
const source = createMssqlSource(outcome.config);
const server = createMssqlMcpServer(source);
serveMcpSourceStdio(() => server);
