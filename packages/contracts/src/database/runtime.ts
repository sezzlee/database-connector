import { z } from "zod";
import { databaseConnectionTestResponseSchema } from "./connection.ts";
import { sealedDatabaseCredentialSchema } from "./credential.ts";

import { sessionIdSchema } from "../chat/session.ts";
import { toolContentBlockSchema } from "../integration/tool-result.ts";
import { workspaceIdSchema } from "../workspace/workspace.ts";
import {
  databaseCaCertificateSchema,
  databaseConnectTimeoutSchema,
  databaseConnectionIdSchema,
  databaseLimits,
  databaseNameSchema,
  databaseNativeNameSchema,
  databasePortSchema,
  databaseQueryTimeoutSchema,
  databaseServerSchema,
  databaseSourceIdSchema,
  postgresqlDatabaseNameSchema,
  postgresqlSslModeSchema,
} from "./database.ts";

/**
 * The managed executor's bearer: at least 32 random bytes as base64 or
 * base64url. The api and the executor validate the same rule, so a token one
 * side accepts can never be one the other refuses at startup.
 */
export const databaseExecutorTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]{43,256}={0,2}$/u);

/** Credentials exist only in authenticated server/runner envelopes. */
export const mssqlRuntimeConfigSchema = z
  .strictObject({
    provider: z.literal("mssql"),
    server: databaseServerSchema,
    port: databasePortSchema.default(1433),
    database: databaseNameSchema,
    username: z.string().min(1).max(256),
    credential: sealedDatabaseCredentialSchema,
    encrypt: z.boolean().default(true),
    trustServerCertificate: z.boolean().default(false),
    connectTimeoutMs: databaseConnectTimeoutSchema.default(
      databaseLimits.connectTimeoutMs.default,
    ),
    queryTimeoutMs: databaseQueryTimeoutSchema.default(
      databaseLimits.queryTimeoutMs.default,
    ),
  })
  .readonly();
export const postgresqlRuntimeConfigSchema = z
  .strictObject({
    provider: z.literal("postgresql"),
    server: databaseServerSchema,
    port: databasePortSchema.default(5432),
    database: postgresqlDatabaseNameSchema,
    username: postgresqlDatabaseNameSchema,
    credential: sealedDatabaseCredentialSchema,
    sslMode: postgresqlSslModeSchema.default("verify-full"),
    caCertificate: databaseCaCertificateSchema.optional(),
    connectTimeoutMs: databaseConnectTimeoutSchema.default(
      databaseLimits.connectTimeoutMs.default,
    ),
    queryTimeoutMs: databaseQueryTimeoutSchema.default(
      databaseLimits.queryTimeoutMs.default,
    ),
  })
  .readonly();
export const databaseRuntimeConfigSchema = z
  .discriminatedUnion("provider", [
    mssqlRuntimeConfigSchema,
    postgresqlRuntimeConfigSchema,
  ])
  .readonly();
export type DatabaseRuntimeConfig = z.infer<typeof databaseRuntimeConfigSchema>;
export const databaseRuntimeMetadataSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    userId: z.uuid(),
    sessionId: sessionIdSchema.optional(),
    sourceId: databaseSourceIdSchema.optional(),
    connectionId: databaseConnectionIdSchema,
    configVersion: z.int().positive(),
    credentialsVersion: z.int().positive(),
    requestId: z.uuid(),
    deadline: z.iso.datetime(),
  })
  .readonly();
export type DatabaseRuntimeMetadata = z.infer<
  typeof databaseRuntimeMetadataSchema
>;
export const databaseRuntimeOperationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("test") }),
    z.strictObject({ kind: z.literal("discover") }),
    z.strictObject({
      kind: z.literal("validate_source"),
      database: databaseNativeNameSchema,
    }),
    z.strictObject({ kind: z.literal("tools/list") }),
    z.strictObject({
      kind: z.literal("tools/call"),
      name: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.unknown()),
    }),
    z.strictObject({ kind: z.literal("close") }),
  ])
  .readonly();
export type DatabaseRuntimeOperation = z.infer<
  typeof databaseRuntimeOperationSchema
>;
export const databaseRuntimeRequestSchema = z
  .strictObject({
    metadata: databaseRuntimeMetadataSchema,
    config: databaseRuntimeConfigSchema,
    operation: databaseRuntimeOperationSchema,
  })
  .readonly();
export type DatabaseRuntimeRequest = z.infer<
  typeof databaseRuntimeRequestSchema
>;
export const databaseRuntimeFailureSchema = z.enum([
  "connection_failed",
  "authentication_failed",
  "certificate_failed",
  "database_unavailable",
  "connector_offline",
  "timeout",
  "invalid_operation",
  "stale_configuration",
  "cancelled",
  "execution_failed",
  "principal_not_read_only",
  "tls_unsupported",
  "credential_rejected",
  "credential_key_unavailable",
  "target_not_allowed",
]);
export type DatabaseRuntimeFailure = z.infer<
  typeof databaseRuntimeFailureSchema
>;
export const databaseRuntimeToolSchema = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type DatabaseRuntimeTool = z.infer<typeof databaseRuntimeToolSchema>;
export const databaseCallToolOutcomeSchema = z.strictObject({
  blocks: z.array(toolContentBlockSchema),
  dropped: z.int().nonnegative(),
  isError: z.boolean(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type DatabaseCallToolOutcome = z.infer<
  typeof databaseCallToolOutcomeSchema
>;

/** Twice the 512 KiB response budget the database servers hold their own results to. */
export const databaseToolResultMaxBytes = 1024 * 1024;

/**
 * Guard: the connector bounds its own results, but a device under someone
 * else's control can send anything its schema admits. The api forwards a tool
 * result only when it carries text blocks alone, no more rows than were asked
 * for, and no more bytes than the servers' budget allows.
 */
export function databaseToolOutcomeWithin(
  outcome: DatabaseCallToolOutcome,
  maxRows: number | undefined,
): boolean {
  if (outcome.blocks.some((block) => block.type !== "text")) return false;
  const rows = outcome.structuredContent?.["rows"];
  if (maxRows !== undefined && Array.isArray(rows) && rows.length > maxRows)
    return false;
  return (
    new TextEncoder().encode(JSON.stringify(outcome)).length <=
    databaseToolResultMaxBytes
  );
}

export const databaseRuntimeResultSchema = z.discriminatedUnion("kind", [
  databaseConnectionTestResponseSchema.extend({ kind: z.literal("test") }),
  z.strictObject({
    kind: z.literal("discover"),
    databases: z.array(databaseNativeNameSchema).max(10000),
  }),
  z.strictObject({
    kind: z.literal("validate_source"),
    valid: z.literal(true),
    database: databaseNativeNameSchema,
  }),
  z.strictObject({
    kind: z.literal("tools/list"),
    tools: z.array(databaseRuntimeToolSchema).max(256),
  }),
  z.strictObject({
    kind: z.literal("tools/call"),
    outcome: databaseCallToolOutcomeSchema,
  }),
  z.strictObject({ kind: z.literal("close"), closed: z.literal(true) }),
]);
export type DatabaseRuntimeResult = z.infer<typeof databaseRuntimeResultSchema>;
export const databaseRuntimeResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    requestId: z.uuid(),
    configVersion: z.int().positive(),
    ok: z.literal(true),
    result: databaseRuntimeResultSchema,
  }),
  z.strictObject({
    requestId: z.uuid(),
    configVersion: z.int().positive(),
    ok: z.literal(false),
    error: databaseRuntimeFailureSchema,
  }),
]);
export type DatabaseRuntimeResponse = z.infer<
  typeof databaseRuntimeResponseSchema
>;

export const databaseExecutorPollSchema = z.strictObject({
  waitMs: z.int().min(0).max(25000).default(25000),
});
export type DatabaseExecutorPoll = z.infer<typeof databaseExecutorPollSchema>;
export const databaseExecutorPollResponseSchema = z
  .strictObject({
    job: databaseRuntimeRequestSchema.optional(),
    leaseId: z.uuid().optional(),
  })
  .refine(
    (value) => (value.job === undefined) === (value.leaseId === undefined),
    { error: "incomplete_lease" },
  );
export type DatabaseExecutorPollResponse = z.infer<
  typeof databaseExecutorPollResponseSchema
>;
export const databaseExecutorHeartbeatSchema = z.strictObject({
  requestId: z.uuid(),
  leaseId: z.uuid(),
});
export type DatabaseExecutorHeartbeat = z.infer<
  typeof databaseExecutorHeartbeatSchema
>;
export const databaseExecutorHeartbeatResponseSchema = z.strictObject({
  accepted: z.boolean(),
  cancelled: z.boolean(),
});
export type DatabaseExecutorHeartbeatResponse = z.infer<
  typeof databaseExecutorHeartbeatResponseSchema
>;
export const databaseExecutorResultSchema = z
  .strictObject({
    requestId: z.uuid(),
    leaseId: z.uuid(),
    response: databaseRuntimeResponseSchema,
  })
  .refine((value) => value.requestId === value.response.requestId, {
    error: "request_mismatch",
  });
export type DatabaseExecutorResult = z.infer<
  typeof databaseExecutorResultSchema
>;
export const databaseExecutorResultResponseSchema = z.strictObject({
  accepted: z.boolean(),
});
export type DatabaseExecutorResultResponse = z.infer<
  typeof databaseExecutorResultResponseSchema
>;
