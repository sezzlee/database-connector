import { z } from "zod";

export const databaseConnectionIdSchema = z.uuid();
export const databaseSourceIdSchema = z.uuid();
export const databaseConnectorIdSchema = z.uuid();
export const databaseIdParamsSchema = z.strictObject({ id: z.uuid() });
export const databaseProviderSchema = z.enum(["mssql", "postgresql"]);
export const postgresqlSslModeSchema = z.enum([
  "disable",
  "require",
  "verify-full",
]);
export type PostgresqlSslMode = z.infer<typeof postgresqlSslModeSchema>;
/**
 * Guard: certificate blocks only. A pasted private key or any other PEM block
 * is refused here, so a key never reaches storage, the job queue or a log.
 */
export const databaseCaCertificateSchema = z
  .string()
  .trim()
  .max(262144)
  .regex(
    /^(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/u,
  );
export const databaseCaCertificateInputSchema = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(databaseCaCertificateSchema.optional());
export type DatabaseProvider = z.infer<typeof databaseProviderSchema>;
export type DatabaseTransport =
  | {
      readonly provider: "mssql";
      readonly encrypt: boolean;
      readonly trustServerCertificate: boolean;
    }
  | {
      readonly provider: "postgresql";
      readonly sslMode: PostgresqlSslMode;
      readonly caCertificate?: string | undefined;
    };

/**
 * Guard: a hosted connection carries the SQL login across the public internet,
 * so it only travels over TLS that verifies the server's certificate. The form
 * offers nothing else, the api refuses anything else and the executor checks
 * again; all three ask this one function.
 */
export function managedTransportAllowed(transport: DatabaseTransport): boolean {
  return transport.provider === "mssql"
    ? transport.encrypt && !transport.trustServerCertificate
    : transport.sslMode === "verify-full";
}
export const databaseStatusSchema = z.enum(["active", "disabled", "error"]);
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;
export const databaseSourceAccessModeSchema = z.enum([
  "workspace",
  "restricted",
]);
export type DatabaseSourceAccessMode = z.infer<
  typeof databaseSourceAccessModeSchema
>;

export const databaseRedistributionModeSchema = z.enum([
  "unrestricted",
  "workspace_only",
  "named_members",
  "blocked",
]);
export type DatabaseRedistributionMode = z.infer<
  typeof databaseRedistributionModeSchema
>;

/**
 * Guard: the ceilings are what one executor job can hold inside its deadline
 * (queue wait, connect and query together), and `maxRows` is the MSSQL server's
 * own cap. A user picks any value beneath them; raising one means raising the
 * job deadline with it.
 */
export const databaseLimits = {
  connectTimeoutMs: { min: 1000, max: 30000, default: 15000 },
  queryTimeoutMs: { min: 1000, max: 90000, default: 30000 },
  maxRows: { min: 1, max: 1000, default: 1000 },
  queueWaitMs: 15000,
} as const;
export const databaseConnectTimeoutSchema = z
  .int()
  .min(databaseLimits.connectTimeoutMs.min)
  .max(databaseLimits.connectTimeoutMs.max);
export const databaseQueryTimeoutSchema = z
  .int()
  .min(databaseLimits.queryTimeoutMs.min)
  .max(databaseLimits.queryTimeoutMs.max);
export const databaseMaxRowsSchema = z
  .int()
  .min(databaseLimits.maxRows.min)
  .max(databaseLimits.maxRows.max);

/** How long one executor job may live, from enqueue to result. */
export function databaseJobBudgetMs(config: {
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
}): number {
  return (
    databaseLimits.queueWaitMs +
    config.connectTimeoutMs +
    config.queryTimeoutMs +
    10000
  );
}
export const databaseJobBudgetCeilingMs = databaseJobBudgetMs({
  connectTimeoutMs: databaseLimits.connectTimeoutMs.max,
  queryTimeoutMs: databaseLimits.queryTimeoutMs.max,
});
export const databaseExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("managed") }),
  z.strictObject({
    kind: z.literal("connector"),
    connectorId: databaseConnectorIdSchema,
  }),
]);
export type DatabaseExecution = z.infer<typeof databaseExecutionSchema>;

/** Provider metadata stays separate from transport and provider implementations. */
export const databaseProviders = [
  { id: "mssql", displayName: "Microsoft SQL Server", defaultPort: 1433 },
  { id: "postgresql", displayName: "PostgreSQL", defaultPort: 5432 },
] as const satisfies readonly {
  id: DatabaseProvider;
  displayName: string;
  defaultPort: number;
}[];
export const databaseProviderCatalogResponseSchema = z.strictObject({
  providers: z.array(
    z.strictObject({
      id: databaseProviderSchema,
      displayName: z.string().min(1).max(200),
      defaultPort: z.int().min(1).max(65535),
    }),
  ),
});
export type DatabaseProviderCatalogResponse = z.infer<
  typeof databaseProviderCatalogResponseSchema
>;

export const databaseNameSchema = z.string().trim().min(1).max(128);

const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  "master",
  "model",
  "msdb",
  "tempdb",
]);

/** SQL Server's own databases: reachable by name, but never offered in discovery. */
export function isSystemDatabase(
  name: string,
  provider: DatabaseProvider = "mssql",
): boolean {
  return provider === "mssql" && SYSTEM_DATABASES.has(name.toLowerCase());
}

export const databaseNativeNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("\0"), { error: "invalid_database_name" });
export const postgresqlDatabaseNameSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\0") && new TextEncoder().encode(value).length <= 63,
    { error: "invalid_database_name" },
  );

/** PostgreSQL quoted names are exact; MSSQL keeps its existing case folding. */
export function databaseIdentity(
  provider: DatabaseProvider,
  name: string,
): string {
  return provider === "mssql" ? name.toLocaleLowerCase("en-US") : name;
}
export const databaseDisplayNameSchema = z.string().trim().min(1).max(200);
export const databaseServerSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !/[\s/\\@?#]/u.test(value), { error: "invalid_server" });
export const databasePortSchema = z.int().min(1).max(65535);
