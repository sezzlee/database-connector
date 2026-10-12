import {
  quotedIdentifier,
  type DbErrorCode,
  type ErrorFactory,
  type QuotedIdentifier,
  type TableRef,
} from "@sezzlee/db-core";

/**
 * Quotes one identifier for T-SQL.
 *
 * Guard: the closing bracket is the only character that escapes, by doubling.
 * Skipping that turns `a]b` into `[a]b]`, which ends the identifier early and
 * lets the rest of the name become syntax — injection through a name that no
 * parameter binding can close.
 */
export function quoteIdentifier(
  name: string,
  fail: ErrorFactory<DbErrorCode>,
): QuotedIdentifier {
  if (name.length === 0) {
    throw fail("invalid_argument", "An identifier may not be empty.");
  }
  if (name.length > 128) {
    throw fail(
      "invalid_argument",
      `An identifier may not exceed 128 characters; this one is ${name.length}.`,
    );
  }
  if (name.includes("\u0000")) {
    throw fail("invalid_argument", "An identifier may not carry a NUL byte.");
  }
  return quotedIdentifier(`[${name.replaceAll("]", "]]")}]`);
}

export function quoteQualified(
  ref: TableRef,
  fail: ErrorFactory<DbErrorCode>,
): QuotedIdentifier {
  const schema = quoteIdentifier(ref.schema, fail);
  const name = quoteIdentifier(ref.name, fail);
  return quotedIdentifier(`${schema}.${name}`);
}
