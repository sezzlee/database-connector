import { z } from "zod";

import {
  databaseCaCertificateInputSchema,
  databaseCaCertificateSchema,
  databaseConnectTimeoutSchema,
  databaseConnectionIdSchema,
  databaseDisplayNameSchema,
  databaseExecutionSchema,
  databaseNameSchema,
  databaseNativeNameSchema,
  databaseLimits,
  databasePortSchema,
  databaseQueryTimeoutSchema,
  databaseServerSchema,
  databaseStatusSchema,
  databaseIdentity,
  postgresqlDatabaseNameSchema,
  postgresqlSslModeSchema,
  type DatabaseProvider,
} from "./database.ts";
import { sealedDatabaseCredentialSchema } from "./credential.ts";
import {
  databaseSourceInputSchema,
  databaseSourceSummarySchema,
} from "./source.ts";

const databasePasswordSchema = z.string().min(1).max(4096);
const mssqlFields = {
  provider: z.literal("mssql"),
  server: databaseServerSchema,
  port: databasePortSchema.default(1433),
  username: z.string().min(1).max(256),
  discoveryDatabase: databaseNameSchema.default("master"),
  execution: databaseExecutionSchema,
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
  connectTimeoutMs: databaseConnectTimeoutSchema.default(
    databaseLimits.connectTimeoutMs.default,
  ),
  queryTimeoutMs: databaseQueryTimeoutSchema.default(
    databaseLimits.queryTimeoutMs.default,
  ),
};
const postgresqlFields = {
  provider: z.literal("postgresql"),
  server: databaseServerSchema,
  port: databasePortSchema.default(5432),
  username: postgresqlDatabaseNameSchema,
  discoveryDatabase: postgresqlDatabaseNameSchema.default("postgres"),
  execution: databaseExecutionSchema,
  sslMode: postgresqlSslModeSchema.default("verify-full"),
  caCertificate: databaseCaCertificateInputSchema.optional(),
  connectTimeoutMs: databaseConnectTimeoutSchema.default(
    databaseLimits.connectTimeoutMs.default,
  ),
  queryTimeoutMs: databaseQueryTimeoutSchema.default(
    databaseLimits.queryTimeoutMs.default,
  ),
};
const mssqlSources = {
  displayName: databaseDisplayNameSchema,
  sources: z
    .array(databaseSourceInputSchema.extend({ database: databaseNameSchema }))
    .min(1)
    .max(100),
};
const postgresqlSources = {
  displayName: databaseDisplayNameSchema,
  sources: z
    .array(
      databaseSourceInputSchema.extend({
        database: postgresqlDatabaseNameSchema,
      }),
    )
    .min(1)
    .max(100),
};
const sealed = { credential: sealedDatabaseCredentialSchema };
const typed = { password: databasePasswordSchema };
const uniqueSources = (input: {
  readonly provider: DatabaseProvider;
  readonly sources: readonly { readonly database: string }[];
}) =>
  new Set(
    input.sources.map((source) =>
      databaseIdentity(input.provider, source.database),
    ),
  ).size === input.sources.length;

export const testDatabaseConnectionSchema = z.discriminatedUnion("provider", [
  z.strictObject({ ...mssqlFields, ...sealed }),
  z.strictObject({ ...postgresqlFields, ...sealed }),
]);
export type TestDatabaseConnection = z.infer<
  typeof testDatabaseConnectionSchema
>;
export type TestDatabaseConnectionRequest = z.input<
  typeof testDatabaseConnectionSchema
>;
export const createDatabaseConnectionSchema = z
  .discriminatedUnion("provider", [
    z.strictObject({ ...mssqlFields, ...sealed, ...mssqlSources }),
    z.strictObject({ ...postgresqlFields, ...sealed, ...postgresqlSources }),
  ])
  .refine(uniqueSources, { error: "duplicate_database" });
export type CreateDatabaseConnection = z.infer<
  typeof createDatabaseConnectionSchema
>;
export type CreateDatabaseConnectionRequest = z.input<
  typeof createDatabaseConnectionSchema
>;
export const databaseConnectionFormSchema = z
  .discriminatedUnion("provider", [
    z.strictObject({ ...mssqlFields, ...typed, ...mssqlSources }),
    z.strictObject({ ...postgresqlFields, ...typed, ...postgresqlSources }),
  ])
  .refine(uniqueSources, { error: "duplicate_database" });
export type DatabaseConnectionForm = z.infer<
  typeof databaseConnectionFormSchema
>;
export type DatabaseConnectionFormRequest = z.input<
  typeof databaseConnectionFormSchema
>;
const updateFields = {
  displayName: databaseDisplayNameSchema.optional(),
  server: databaseServerSchema.optional(),
  port: databasePortSchema.optional(),
  username: z.string().min(1).max(256).optional(),
  discoveryDatabase: databaseNativeNameSchema.optional(),
  execution: databaseExecutionSchema.optional(),
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
  sslMode: postgresqlSslModeSchema.optional(),
  caCertificate: databaseCaCertificateSchema.nullable().optional(),
  connectTimeoutMs: databaseConnectTimeoutSchema.optional(),
  queryTimeoutMs: databaseQueryTimeoutSchema.optional(),
  status: databaseStatusSchema.optional(),
};
export const updateDatabaseConnectionSchema = z
  .strictObject({
    ...updateFields,
    credential: sealedDatabaseCredentialSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { error: "empty_update" })
  /*
   * Guard: the browser never reads the SQL login back, and a password is
   * sealed to the login it was typed with, so a new password must arrive
   * with the login it was sealed for.
   */
  .refine(
    (input) => input.credential === undefined || input.username !== undefined,
    { error: "username_required", path: ["username"] },
  );
export type UpdateDatabaseConnection = z.infer<
  typeof updateDatabaseConnectionSchema
>;
export type UpdateDatabaseConnectionRequest = z.input<
  typeof updateDatabaseConnectionSchema
>;
export const updateDatabaseConnectionFormSchema = z.strictObject({
  ...updateFields,
  caCertificate: databaseCaCertificateInputSchema.optional(),
  password: z.string().max(4096).optional(),
});
export type UpdateDatabaseConnectionFormRequest = z.input<
  typeof updateDatabaseConnectionFormSchema
>;
/** Strict projection prevents accidental credential reflection. */
const databaseConnectionSummaryShape = {
  id: databaseConnectionIdSchema,
  displayName: databaseDisplayNameSchema,
  server: databaseServerSchema,
  port: databasePortSchema,
  discoveryDatabase: databaseNameSchema,
  execution: databaseExecutionSchema,
  connectTimeoutMs: databaseConnectTimeoutSchema,
  queryTimeoutMs: databaseQueryTimeoutSchema,
  status: databaseStatusSchema,
  credentialsRequired: z.boolean(),
  configVersion: z.int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  sources: z.array(databaseSourceSummarySchema),
};
export const databaseConnectionSummarySchema = z.discriminatedUnion(
  "provider",
  [
    z.strictObject({
      ...databaseConnectionSummaryShape,
      provider: z.literal("mssql"),
      encrypt: z.boolean(),
      trustServerCertificate: z.boolean(),
    }),
    z.strictObject({
      ...databaseConnectionSummaryShape,
      provider: z.literal("postgresql"),
      discoveryDatabase: postgresqlDatabaseNameSchema,
      sslMode: postgresqlSslModeSchema,
      caCertificate: databaseCaCertificateSchema.nullable(),
    }),
  ],
);
export type DatabaseConnectionSummary = z.infer<
  typeof databaseConnectionSummarySchema
>;
export const databaseConnectionListResponseSchema = z.strictObject({
  connections: z.array(databaseConnectionSummarySchema),
});
export type DatabaseConnectionListResponse = z.infer<
  typeof databaseConnectionListResponseSchema
>;
export const databaseConnectionTestResponseSchema = z.strictObject({
  connected: z.literal(true),
  readiness: z
    .strictObject({
      metadata: z.enum(["readable", "unavailable", "unknown"]),
      readOnly: z.enum(["session", "principal_required", "unknown"]),
      principal: z.enum(["read_only", "writable", "administrator", "unknown"]),
    })
    .optional(),
});
export type DatabaseConnectionTestResponse = z.infer<
  typeof databaseConnectionTestResponseSchema
>;
export type DatabaseReadiness = NonNullable<
  DatabaseConnectionTestResponse["readiness"]
>;

/** A writable account passes only when every query is held to a read-only transaction. */
export function databaseReadinessPermitsQueries({
  principal,
  readOnly,
}: DatabaseReadiness): boolean {
  return (
    principal === "read_only" ||
    (principal === "writable" && readOnly === "session")
  );
}
