import {
  quotedIdentifier,
  type DbErrorCode,
  type ErrorFactory,
  type TableRef,
} from "@sezzlee/db-core";

export function quoteIdentifier(name: string, fail: ErrorFactory<DbErrorCode>) {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    Buffer.byteLength(name, "utf8") > 63
  )
    throw fail(
      "invalid_argument",
      "PostgreSQL identifiers must contain 1 to 63 UTF-8 bytes and no NUL.",
    );
  return quotedIdentifier(`"${name.replaceAll('"', '""')}"`);
}
export function quoteQualified(ref: TableRef, fail: ErrorFactory<DbErrorCode>) {
  return quotedIdentifier(
    `${quoteIdentifier(ref.schema, fail)}.${quoteIdentifier(ref.name, fail)}`,
  );
}
