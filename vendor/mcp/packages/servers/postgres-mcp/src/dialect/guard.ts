import {
  asciiLower,
  asciiUpper,
  sqlText,
  type GuardOutcome,
} from "@sezzlee/db-core";

type Scan =
  | { readonly kind: "open" }
  | { readonly kind: "unicode_identifier" }
  | {
      readonly kind: "closed";
      readonly first: string | undefined;
      readonly statements: number;
      readonly calls: readonly string[];
    };

/**
 * Guard: built-in functions whose effect a read-only transaction that is
 * rolled back does not contain. This list is an added layer, not the boundary:
 * it cannot see functions the database defines or reaches through views, so
 * the principal and the transaction remain what the guarantees rest on.
 */
const containedNot: ReadonlyMap<string, string> = new Map([
  ["pg_cancel_backend", "signals another session"],
  ["pg_terminate_backend", "signals another session"],
  ["pg_advisory_lock", "takes a session lock that outlives the transaction"],
  [
    "pg_advisory_lock_shared",
    "takes a session lock that outlives the transaction",
  ],
  [
    "pg_try_advisory_lock",
    "takes a session lock that outlives the transaction",
  ],
  [
    "pg_try_advisory_lock_shared",
    "takes a session lock that outlives the transaction",
  ],
  ["pg_logical_emit_message", "writes to the WAL outside the transaction"],
  ["query_to_xml", "runs SQL text this check never sees"],
  ["query_to_xmlschema", "runs SQL text this check never sees"],
  ["query_to_xml_and_xmlschema", "runs SQL text this check never sees"],
  ["cursor_to_xml", "runs SQL text this check never sees"],
  ["cursor_to_xmlschema", "runs SQL text this check never sees"],
  ["ts_stat", "runs SQL text this check never sees"],
  ["ts_rewrite", "runs SQL text this check never sees"],
]);

const uncontained = (name: string): string | undefined =>
  containedNot.get(name) ??
  (name.startsWith("dblink")
    ? "opens a connection outside this transaction"
    : undefined);

/**
 * Guard: PostgreSQL treats every byte from 0x80 up as an identifier character
 * and only space, tab, line feed, carriage return, form feed and vertical tab
 * as whitespace. Reading a non-ASCII letter as a separator would let `ée'\'…'`
 * look like an escape string here while the server reads an identifier and a
 * plain string that ends at the second quote.
 */
const word = /^[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z_0-9$\u{80}-\u{10FFFF}]*/u;
const whitespace = /[ \t\n\r\f\v]/;
const dollarTag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

const unquote = (body: string): string => body.replaceAll('""', '"');

function closingQuote(
  sql: string,
  start: number,
  quote: string,
  backslash: boolean,
): number {
  for (let index = start; index < sql.length; index++) {
    if (backslash && sql[index] === "\\") {
      index++;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index++;
    }
  }
  return -1;
}

/**
 * Guard: PostgreSQL joins string constants separated by whitespace holding a
 * line break, and the joined part keeps the first part's escape rules. Reading
 * `E'a'` + newline + `'\''` as two literals would end the second one a quote
 * later than the server does. The pattern is the server's `quotecontinue`.
 */
const continuation =
  /^[ \t\f]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/u;

function closingLiteral(sql: string, start: number, backslash: boolean) {
  let end = closingQuote(sql, start, "'", backslash);
  while (end >= 0) {
    const next = continuation.exec(sql.slice(end))?.[0];
    if (next === undefined) return end;
    end = closingQuote(sql, end + next.length, "'", backslash);
  }
  return end;
}

function closingComment(sql: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth--;
      index += 2;
      if (depth === 0) return index;
    } else index++;
  }
  return -1;
}

/**
 * Guard: the lexer has to agree with the server about where a literal ends, or
 * a `;` inside one is counted as a statement boundary and the other way round.
 * `E'…'` is the only form where a backslash escapes the quote; every other form
 * relies on the `standard_conforming_strings=on` the query scope sets. A `--`
 * comment ends at a carriage return as well as a line feed, as in the server.
 * A name directly followed by `(` is recorded as a call under the name the
 * server resolves: unquoted lowered, quoted with `""` undone. A `U&"…"` name is
 * refused rather than decoded, since its escape character is itself
 * configurable and no analytical query needs one.
 */
function scan(sql: string): Scan {
  let first: string | undefined;
  let statements = 0;
  let pending = false;
  let index = 0;
  let name: string | undefined;
  const calls: string[] = [];
  const token = (value: string, called?: string) => {
    if (!pending) first ??= value;
    pending = true;
    name = called;
  };
  while (index < sql.length) {
    const here = sql[index]!;
    if (whitespace.test(here)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.slice(index + 2).search(/[\r\n]/u);
      index = end < 0 ? sql.length : index + 2 + end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = closingComment(sql, index + 2);
      if (index < 0) return { kind: "open" };
      continue;
    }
    if (here === ";") {
      if (pending) statements++;
      pending = false;
      index++;
      continue;
    }
    if (here === "'" || here === '"') {
      const start = index + 1;
      index =
        here === "'"
          ? closingLiteral(sql, start, false)
          : closingQuote(sql, start, here, false);
      if (index < 0) return { kind: "open" };
      token(
        here,
        here === '"' ? unquote(sql.slice(start, index - 1)) : undefined,
      );
      continue;
    }
    const tag =
      here === "$" ? dollarTag.exec(sql.slice(index))?.[0] : undefined;
    if (tag !== undefined) {
      const end = sql.indexOf(tag, index + tag.length);
      if (end < 0) return { kind: "open" };
      index = end + tag.length;
      token("$");
      continue;
    }
    const bare = word.exec(sql.slice(index))?.[0];
    if (bare !== undefined) {
      const lower = asciiLower(bare);
      index += bare.length;
      if (lower === "e" && sql[index] === "'") {
        index = closingLiteral(sql, index + 1, true);
        if (index < 0) return { kind: "open" };
        token("'");
        continue;
      }
      if (lower === "u" && sql[index] === "&" && sql[index + 1] === '"')
        return { kind: "unicode_identifier" };
      if (lower === "u" && sql[index] === "&" && sql[index + 1] === "'") {
        index = closingLiteral(sql, index + 2, false);
        if (index < 0) return { kind: "open" };
        token("'");
        continue;
      }
      token(lower, lower);
      continue;
    }
    if (here === "(") {
      if (name !== undefined) calls.push(name);
      name = undefined;
    } else token(here);
    index++;
  }
  if (pending) statements++;
  return { kind: "closed", first, statements, calls };
}

const refuse = (reason: string, recovery: string): GuardOutcome => ({
  verdict: "refuse",
  reason,
  recovery,
});

export function readOnlyGuard(sql: string): GuardOutcome {
  const outcome = scan(sql);
  if (outcome.kind === "unicode_identifier")
    return refuse(
      'The statement carries a Unicode-escaped identifier (U&"…").',
      "Write the name plainly or double-quoted.",
    );
  if (outcome.kind === "open")
    return refuse(
      "A string, quoted identifier, dollar-quoted body or block comment is not closed.",
      "Close it and send the statement again.",
    );
  if (outcome.statements === 0)
    return refuse(
      "The statement is empty once comments are removed.",
      "Send one SELECT statement.",
    );
  if (outcome.statements > 1)
    return refuse(
      `The text carries ${outcome.statements} statements; only one is allowed.`,
      "Send a single SELECT or WITH statement, with no semicolon-separated batch.",
    );
  if (outcome.first !== "select" && outcome.first !== "with")
    return refuse(
      `A query has to begin with SELECT or WITH; this one begins with ${asciiUpper(outcome.first ?? "nothing")}.`,
      "Rewrite the request as a SELECT.",
    );
  for (const call of outcome.calls) {
    const effect = uncontained(asciiLower(call));
    if (effect !== undefined)
      return refuse(
        `The statement calls ${call}, which ${effect}.`,
        "Read the data with a plain SELECT and built-in read functions.",
      );
  }
  return { verdict: "allow", statement: sqlText(sql) };
}
