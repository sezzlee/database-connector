import type { DatabaseProvider } from "@chat/contracts/database/database";
import type { DatabaseRuntimeFailure } from "@chat/contracts/database/runtime";

function nativeCodes(error: unknown): readonly (string | number)[] {
  const codes: (string | number)[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (
      value === null ||
      typeof value !== "object" ||
      depth > 5 ||
      seen.has(value)
    )
      return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "number"])
      if (typeof record[key] === "string" || typeof record[key] === "number")
        codes.push(record[key]);
    for (const key of ["cause", "originalError", "info", "context"])
      visit(record[key], depth + 1);
  };
  visit(error, 0);
  return codes;
}

export function classifyRuntimeFailure(
  error: unknown,
  provider: DatabaseProvider,
  signal: AbortSignal,
): DatabaseRuntimeFailure {
  if (signal.aborted)
    return signal.reason instanceof DOMException &&
      signal.reason.name === "TimeoutError"
      ? "timeout"
      : "cancelled";
  const codes = nativeCodes(error);
  const detail = error instanceof Error ? `${error.name} ${error.message}` : "";
  if (
    provider === "postgresql" &&
    (codes.includes("PG_TLS_UNSUPPORTED") ||
      /\bPG_TLS_UNSUPPORTED\b/.test(detail))
  )
    return "tls_unsupported";
  if (codes.includes("authentication_failed")) return "authentication_failed";
  if (codes.includes("database_unavailable")) return "database_unavailable";
  if (
    codes.some(
      (code) =>
        typeof code === "string" &&
        /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code),
    )
  )
    return "certificate_failed";
  if (provider === "mssql") {
    if (codes.some((code) => code === "ELOGIN" || code === 18456))
      return "authentication_failed";
    if (codes.includes(4060)) return "database_unavailable";
  } else {
    if (codes.some((code) => code === "28P01" || code === "28000"))
      return "authentication_failed";
    if (codes.includes("3D000")) return "database_unavailable";
    if (codes.includes("57014"))
      return /statement timeout/i.test(detail) ? "timeout" : "cancelled";
  }
  if (
    codes.some(
      (code) =>
        code === "ETIMEOUT" || code === "ETIMEDOUT" || code === "query_timeout",
    )
  )
    return "timeout";
  if (codes.some((code) => code === "query_cancelled" || code === "ECANCEL"))
    return "cancelled";
  if (codes.includes("invalid_operation")) return "invalid_operation";
  if (/certificate|CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(detail))
    return "certificate_failed";
  if (provider === "mssql" && /ELOGIN|login failed|18456/i.test(detail))
    return "authentication_failed";
  if (
    provider === "mssql" &&
    /database.*(unavailable|cannot open)|4060/i.test(detail)
  )
    return "database_unavailable";
  if (/timeout|timed out/i.test(detail)) return "timeout";
  if (/invalid_operation/.test(detail)) return "invalid_operation";
  return "connection_failed";
}
