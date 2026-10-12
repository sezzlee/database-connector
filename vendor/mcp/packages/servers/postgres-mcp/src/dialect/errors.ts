import type { DbErrorCode, DriverFailure } from "@sezzlee/db-core";

type MappedCode = Extract<
  DbErrorCode,
  | "database_unavailable"
  | "connection_failed"
  | "query_timeout"
  | "query_cancelled"
  | "authentication_failed"
  | "write_not_permitted"
  | "permission_denied"
  | "object_not_found"
  | "deadlock"
  | "query_failed"
>;

/**
 * Guard: total over every code this mapping produces, so a code added without a
 * recovery does not compile and no failure reaches the agent with advice written
 * for another one.
 */
const recoveries: Readonly<Record<MappedCode, string>> = {
  database_unavailable:
    "Check that the configured database exists and that the principal can open it.",
  connection_failed: "Check database reachability and verified TLS settings.",
  query_timeout:
    "Narrow the query with a filter or a paging clause, or pass a larger timeoutMs.",
  query_cancelled:
    "The call ended before the statement finished; call again if the answer is still needed.",
  authentication_failed: "Check the configured database credentials.",
  write_not_permitted:
    "Every query runs in a read-only transaction; send a statement that only reads.",
  permission_denied:
    "The connected principal cannot read that object; ask for one search_catalog returns.",
  object_not_found:
    "Call search_catalog for the names this connection can read.",
  deadlock: "The call was chosen as a deadlock victim; retrying may succeed.",
  query_failed:
    "Read the engine's message, correct the statement and call again.",
};

/**
 * Guard: Node reports a certificate the TLS handshake rejects with OpenSSL's
 * verification code (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, measured against a
 * PostgreSQL 16 server under `verify-full`) or, for a host name the certificate
 * does not name, `ERR_TLS_CERT_ALTNAME_INVALID`. Neither is a SQLSTATE, so
 * without this set the failure fell through to `query_failed`.
 */
const certificateCodes: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const connectionCodes: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "PG_CONNECTION_CLOSED",
  "PG_TLS_UNSUPPORTED",
  "57P01",
  "57P02",
  "57P03",
]);

const specificRecoveries: Readonly<Record<string, string>> = {
  PG_TLS_UNSUPPORTED:
    "The server does not accept TLS. Enable TLS on the server, or set sslMode to disable only on a trusted network.",
};

const certificateRecovery =
  "The server's certificate was not verified for the configured host. Give the server a certificate that chains to a trusted authority and names that host, or pass caCertificate when embedding for a private authority; sslMode require skips verification and belongs only on a trusted network.";

/** Guard: PostgreSQL uses SQLSTATE 57014 for both statement deadlines and external cancellation; the canonical timeout diagnostic distinguishes only the deadline case. */
const isStatementTimeout = (code: string, message: string) =>
  code === "57014" &&
  /canceling statement due to statement timeout\b/i.test(message);

function classify(code: string, message: string): MappedCode {
  if (code === "3D000") return "database_unavailable";
  if (certificateCodes.has(code) || connectionCodes.has(code)) {
    return "connection_failed";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    isStatementTimeout(code, message)
  ) {
    return "query_timeout";
  }
  if (code === "ECANCEL" || code === "57014") return "query_cancelled";
  if (code.startsWith("28")) return "authentication_failed";
  if (code === "25006") return "write_not_permitted";
  if (code === "42501") return "permission_denied";
  if (code === "42P01" || code === "42703") return "object_not_found";
  if (code === "40P01") return "deadlock";
  if (code.startsWith("08")) return "connection_failed";
  return "query_failed";
}

export function mapDriverError(error: unknown): DriverFailure | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return undefined;
  const code = error.code;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "PostgreSQL rejected the operation.";
  const mapped = classify(code, message);
  return {
    code: mapped,
    message,
    engineCode: code,
    recovery:
      specificRecoveries[code] ??
      (certificateCodes.has(code) ? certificateRecovery : recoveries[mapped]),
  };
}
