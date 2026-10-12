import type { DbErrorCode, DriverFailure } from "@sezzlee/db-core";

interface RequestErrorShape {
  readonly code?: unknown;
  readonly number?: unknown;
  readonly message?: unknown;
}

/**
 * Guard: the driver reports two different things in two different fields. A
 * connection-level fault carries a string `code` (`ECANCEL`, `ELOGIN`), while a
 * server-side fault carries `code: "EREQUEST"` and the real reason in the
 * numeric `number`. Reading only one of them misclassifies half the failures.
 * 208, 2812, 8134 and `ECANCEL` were measured on tedious@18.6.2. 2812 is a
 * user error, not a missing procedure: SQL Server reads an unknown first word as
 * a stored-procedure call, so `selct 1` answers "Could not find stored
 * procedure".
 */
type MappedCode = Extract<
  DbErrorCode,
  | "object_not_found"
  | "invalid_argument"
  | "permission_denied"
  | "deadlock"
  | "query_failed"
  | "query_cancelled"
  | "query_timeout"
  | "authentication_failed"
  | "connection_failed"
  | "database_unavailable"
>;

const byNumber: Readonly<Record<number, MappedCode>> = {
  4060: "database_unavailable",
  208: "object_not_found",
  2812: "invalid_argument",
  229: "permission_denied",
  230: "permission_denied",
  262: "permission_denied",
  297: "permission_denied",
  916: "permission_denied",
  1205: "deadlock",
  8134: "invalid_argument",
  102: "invalid_argument",
  156: "invalid_argument",
  207: "invalid_argument",
  4145: "invalid_argument",
};

const byCode: Readonly<Record<string, MappedCode>> = {
  ECANCEL: "query_cancelled",
  ETIMEOUT: "query_timeout",
  ELOGIN: "authentication_failed",
  ESOCKET: "connection_failed",
  ECONNCLOSED: "connection_failed",
  ENOTOPEN: "connection_failed",
  ENOCONN: "connection_failed",
  EINSTLOOKUP: "connection_failed",
};

/**
 * Guard: total over every code this mapping produces, so a code added to either
 * table without a recovery does not compile. A partial table let
 * query_timeout, query_cancelled and query_failed reach the agent with no next
 * step, which the envelope reserves for internal_error.
 */
const recoveries: Readonly<Record<MappedCode, string>> = {
  object_not_found:
    "Call search_catalog for the names this connection can read.",
  permission_denied:
    "The connected principal cannot read that object; ask for one search_catalog returns.",
  deadlock: "The call was chosen as a deadlock victim; retrying may succeed.",
  invalid_argument: "Correct the statement and call again.",
  authentication_failed:
    "This is a server configuration problem, not something the call can fix.",
  connection_failed:
    "The database was not reachable; retrying may succeed once it is.",
  database_unavailable:
    "Check that the configured database exists and that the principal can open it.",
  query_timeout:
    "Narrow the query with a filter or a paging clause, or pass a larger timeoutMs.",
  query_cancelled:
    "The call ended before the statement finished; call again if the answer is still needed.",
  query_failed:
    "Read the engine's message, correct the statement and call again.",
};

export function mapDriverError(error: unknown): DriverFailure | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const shape = error as RequestErrorShape;
  const message =
    typeof shape.message === "string" ? shape.message : "The query failed.";
  const code = typeof shape.code === "string" ? shape.code : undefined;

  if (shape.number === 4060) {
    return {
      code: "database_unavailable",
      message,
      engineCode: 4060,
      recovery: recoveries.database_unavailable,
    };
  }

  if (code === "EREQUEST") {
    const number = typeof shape.number === "number" ? shape.number : undefined;
    const mapped =
      number === undefined
        ? "query_failed"
        : (byNumber[number] ?? "query_failed");
    return {
      code: mapped,
      message,
      ...(number === undefined ? {} : { engineCode: number }),
      recovery: recoveries[mapped],
    };
  }

  if (code !== undefined && byCode[code] !== undefined) {
    const mapped = byCode[code];
    return {
      code: mapped,
      message,
      engineCode: code,
      recovery: recoveries[mapped],
    };
  }

  return undefined;
}
