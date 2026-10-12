import { z } from "zod";

export const postgresConfigSchema = z.object({
  server: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  sslMode: z.enum(["disable", "require", "verify-full"]),
  caCertificate: z.string().min(1).optional(),
  connectTimeoutMs: z.number().int().min(1).max(300000),
  queryTimeoutMs: z.number().int().min(1).max(300000),
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type EnvRecord = Readonly<Record<string, string | undefined>>;
export type EnvOutcome =
  | { readonly kind: "ready"; readonly config: PostgresConfig }
  | { readonly kind: "usage"; readonly missing: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

export const requiredNames = [
  "SEZZLEE_POSTGRES_SERVER",
  "SEZZLEE_POSTGRES_DATABASE",
  "SEZZLEE_POSTGRES_USER",
  "SEZZLEE_POSTGRES_PASSWORD",
] as const;

export function readPostgresEnv(env: EnvRecord): EnvOutcome {
  const missing = requiredNames.filter((name) => !env[name]);
  if (missing.length > 0) return { kind: "usage", missing };
  const parsed = postgresConfigSchema.safeParse({
    server: env["SEZZLEE_POSTGRES_SERVER"],
    port: Number(env["SEZZLEE_POSTGRES_PORT"] ?? 5432),
    database: env["SEZZLEE_POSTGRES_DATABASE"],
    user: env["SEZZLEE_POSTGRES_USER"],
    password: env["SEZZLEE_POSTGRES_PASSWORD"],
    sslMode: env["SEZZLEE_POSTGRES_SSL_MODE"] ?? "verify-full",
    connectTimeoutMs: Number(
      env["SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS"] ?? 30000,
    ),
    queryTimeoutMs: Number(env["SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS"] ?? 30000),
  });
  return parsed.success
    ? { kind: "ready", config: parsed.data }
    : {
        kind: "invalid",
        reason: `Invalid PostgreSQL configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`,
      };
}

export function redactedConfig(config: PostgresConfig) {
  return {
    port: config.port,
    sslMode: config.sslMode,
    connectTimeoutMs: config.connectTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
  };
}
