export {
  readPostgresEnv,
  redactedConfig,
  requiredNames,
  postgresConfigSchema,
  type EnvOutcome,
  type EnvRecord,
  type PostgresConfig,
} from "./platform/env.js";
export {
  asPostgresError,
  fail,
  redact,
  secretPatterns,
  SezzleePostgresError,
  type SezzleePostgresErrorCode,
} from "./platform/errors.js";
export { limits } from "./platform/limits.js";
export { vocabulary } from "./platform/vocabulary.js";
export { createPostgresDialect, postgresDialect } from "./dialect/index.js";
export { readOnlyGuard } from "./dialect/guard.js";
export { quoteIdentifier, quoteQualified } from "./dialect/quote.js";
export { describeType } from "./dialect/types.js";
export { mapDriverError } from "./dialect/errors.js";
export {
  createPostgresDriver,
  type PostgresDriverOptions,
  type PostgresClient,
  type PostgresCursor,
  type PostgresField,
} from "./driver/adapter.js";
export { createPostgresMcpServer, createPostgresSource } from "./server.js";
