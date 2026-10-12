#!/usr/bin/env node
import { serveMcpSourceStdio } from "@sezzlee/db-core";
import { readPostgresEnv, requiredNames } from "./platform/env.js";
import { createPostgresMcpServer, createPostgresSource } from "./server.js";

const outcome = readPostgresEnv({
  SEZZLEE_POSTGRES_SERVER: process.env["SEZZLEE_POSTGRES_SERVER"],
  SEZZLEE_POSTGRES_PORT: process.env["SEZZLEE_POSTGRES_PORT"],
  SEZZLEE_POSTGRES_DATABASE: process.env["SEZZLEE_POSTGRES_DATABASE"],
  SEZZLEE_POSTGRES_USER: process.env["SEZZLEE_POSTGRES_USER"],
  SEZZLEE_POSTGRES_PASSWORD: process.env["SEZZLEE_POSTGRES_PASSWORD"],
  SEZZLEE_POSTGRES_SSL_MODE: process.env["SEZZLEE_POSTGRES_SSL_MODE"],
  SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS:
    process.env["SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS"],
  SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS:
    process.env["SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS"],
});
if (outcome.kind !== "ready") {
  process.stderr.write(
    `${outcome.kind === "usage" ? `Missing: ${outcome.missing.join(", ")}. Required: ${requiredNames.join(", ")}.` : outcome.reason}\n`,
  );
  process.exit(2);
}
const source = createPostgresSource(outcome.config);
serveMcpSourceStdio(() => createPostgresMcpServer(source));
