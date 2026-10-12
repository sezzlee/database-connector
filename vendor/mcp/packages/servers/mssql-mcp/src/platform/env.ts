export interface MssqlConfig {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly encrypt: boolean;
  readonly trustServerCertificate: boolean;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
}

/** Everything about the connection that is safe to print. */
export interface RedactedConfig {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly encrypt: boolean;
}

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export type EnvOutcome =
  | { readonly kind: "config"; readonly config: MssqlConfig }
  | { readonly kind: "usage"; readonly missing: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

export const requiredNames = [
  "SEZZLEE_MSSQL_SERVER",
  "SEZZLEE_MSSQL_DATABASE",
  "SEZZLEE_MSSQL_USER",
  "SEZZLEE_MSSQL_PASSWORD",
] as const;

function flag(raw: string | undefined, fallback: boolean): boolean | undefined {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  return undefined;
}

function count(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function redactedConfig(config: MssqlConfig): RedactedConfig {
  return {
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    encrypt: config.encrypt,
  };
}

/**
 * Reads the connection from an environment record.
 *
 * Guard: pure, and the record is a parameter — the process environment is read
 * once in `cli.ts` and nowhere else, so every variable is named explicitly and
 * `turbo/no-undeclared-env-vars` forces it into `turbo.json`'s `passThroughEnv`.
 * Parsing is eager and fatal while connecting stays lazy, so a dead database
 * cannot stop the server from starting and answering `tools/list`.
 */
export function readMssqlEnv(env: EnvRecord): EnvOutcome {
  const missing = requiredNames.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    return { kind: "usage", missing };
  }
  const port = count(env["SEZZLEE_MSSQL_PORT"], 1433);
  const connectTimeoutMs = count(
    env["SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS"],
    15_000,
  );
  const queryTimeoutMs = count(env["SEZZLEE_MSSQL_QUERY_TIMEOUT_MS"], 30_000);
  const encrypt = flag(env["SEZZLEE_MSSQL_ENCRYPT"], true);
  const trustServerCertificate = flag(
    env["SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE"],
    false,
  );
  if (port === undefined) {
    return {
      kind: "invalid",
      reason: "SEZZLEE_MSSQL_PORT must be a positive integer.",
    };
  }
  if (connectTimeoutMs === undefined) {
    return {
      kind: "invalid",
      reason: "SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS must be a positive integer.",
    };
  }
  if (queryTimeoutMs === undefined) {
    return {
      kind: "invalid",
      reason: "SEZZLEE_MSSQL_QUERY_TIMEOUT_MS must be a positive integer.",
    };
  }
  if (encrypt === undefined || trustServerCertificate === undefined) {
    return {
      kind: "invalid",
      reason:
        "SEZZLEE_MSSQL_ENCRYPT and SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE must be true or false.",
    };
  }
  return {
    kind: "config",
    config: {
      server: env["SEZZLEE_MSSQL_SERVER"] ?? "",
      port,
      database: env["SEZZLEE_MSSQL_DATABASE"] ?? "",
      user: env["SEZZLEE_MSSQL_USER"] ?? "",
      password: env["SEZZLEE_MSSQL_PASSWORD"] ?? "",
      encrypt,
      trustServerCertificate,
      connectTimeoutMs,
      queryTimeoutMs,
    },
  };
}
