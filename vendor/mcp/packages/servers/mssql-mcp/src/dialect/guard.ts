import {
  asciiLower,
  asciiUpper,
  sqlText,
  type GuardOutcome,
} from "@sezzlee/db-core";

/**
 * Guard: T-SQL needs no `;` between statements, so `select 1 delete from t` is
 * a batch of two and counting semicolons cannot find the boundary. Every word
 * here is reserved in T-SQL, or a Service Broker verb, and so is how a second
 * statement, a write inside this one, or a rowset function that runs under
 * another server's login is recognised.
 */
const statementKeywords = [
  "insert",
  "update",
  "delete",
  "merge",
  "drop",
  "alter",
  "create",
  "truncate",
  "exec",
  "execute",
  "grant",
  "revoke",
  "deny",
  "backup",
  "restore",
  "shutdown",
  "reconfigure",
  "waitfor",
  "into",
  "openquery",
  "openrowset",
  "opendatasource",
  "bulk",
  "use",
  "declare",
  "set",
  "begin",
  "commit",
  "rollback",
  "kill",
  "dbcc",
  "writetext",
  "updatetext",
  "setuser",
  "revert",
  "save",
  "receive",
  "send",
];

/** Guard: ending a `--` comment early can only expose more text to the checks below, never hide any. */
const lineEnd = /[\n\r\v\f\u0085\u2028\u2029]/u;

/**
 * Guard: a control or format character (NUL, a zero-width space, a BOM) may be
 * skipped by the server's lexer while it splits a word here, so `de\u200blete`
 * would be one keyword to the server and two harmless words to this check.
 * Nothing legitimate needs one, so the text is refused outright.
 */
const invisible = (text: string): boolean =>
  /\p{Cf}/u.test(text) ||
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && !"\t\n\v\f\r".includes(char)) ||
      (code >= 0x7f && code <= 0x9f)
    );
  });

const keywordSet: ReadonlySet<string> = new Set(statementKeywords);

/**
 * Guard: words are cut the way the T-SQL lexer cuts them, not at `\b`. A
 * number ends where its digits, exponent or hex digits end, so `1delete` is
 * `1` followed by `delete`; an identifier runs through digits, so `a1delete` is
 * one name. Anything outside ASCII splits a word here, which can only find more
 * keywords than the server sees, never fewer.
 */
const lexeme =
  /0x[0-9a-f]*|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d*)?|[a-z_@#][a-z0-9_@#$]*/gu;

/**
 * Guard: a letter that folds to an ASCII one (`İ`, `ı`, a fullwidth form) is
 * folded before lexing, so a keyword spelled with one is still found whether or
 * not the server's collation would read it as that keyword.
 */
const fold = (text: string): string =>
  asciiLower(
    text.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("ı", "i"),
  );

const words = (masked: string): readonly string[] =>
  [...fold(masked).matchAll(lexeme)]
    .map((match) => match[0])
    .filter((word) => !/^[\d.]/u.test(word));

interface Normalised {
  readonly masked: string;
  readonly statements: readonly string[];
}

/**
 * Guard: comments and literals are removed before statements are counted, so a
 * `;` inside a string, a bracketed identifier or a comment is not read as a
 * batch boundary and a comment cannot hide a second statement.
 */
function normalise(sql: string): Normalised {
  let masked = "";
  let index = 0;
  while (index < sql.length) {
    const here = sql[index];
    const next = sql[index + 1];
    if (here === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      masked += "''";
      index = end + 1;
      continue;
    }
    if (here === "[") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "]") {
          if (sql[end + 1] === "]") {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      masked += " id ";
      index = end + 1;
      continue;
    }
    if (here === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === '"') {
          if (sql[end + 1] === '"') {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      masked += " id ";
      index = end + 1;
      continue;
    }
    if (here === "-" && next === "-") {
      while (index < sql.length && !lineEnd.test(sql[index] ?? "")) {
        index += 1;
      }
      masked += " ";
      continue;
    }
    if (here === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      masked += " ";
      continue;
    }
    masked += here;
    index += 1;
  }
  const statements = masked
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { masked: asciiLower(masked), statements };
}

const refuse = (reason: string, recovery: string): GuardOutcome => ({
  verdict: "refuse",
  reason,
  recovery,
});

/**
 * Decides whether one statement may run.
 *
 * Guard: the principal `run_query` verifies is the boundary for writes in this
 * database. This check is what keeps the text to one statement, because MSSQL
 * has neither a read-only session nor a protocol that refuses a batch. Its
 * `allow` arm is the only place agent text becomes `SqlText`.
 */
export function readOnlyGuard(sql: string): GuardOutcome {
  if (invisible(sql)) {
    return refuse(
      "The statement carries a control or invisible formatting character.",
      "Remove it and send the statement again.",
    );
  }
  const { masked, statements } = normalise(sql);
  if (statements.length === 0) {
    return refuse(
      "The statement is empty once comments are removed.",
      "Send one SELECT statement.",
    );
  }
  if (statements.length > 1) {
    return refuse(
      `The text carries ${statements.length} statements; only one is allowed.`,
      "Send a single SELECT statement, with no semicolon-separated batch.",
    );
  }
  const first = /^[\s(]*(\w+)/u.exec(masked)?.[1];
  if (first !== "select" && first !== "with") {
    return refuse(
      `A read-only statement has to begin with SELECT or WITH; this one begins with ${asciiUpper(first ?? "nothing")}.`,
      "Rewrite the request as a SELECT.",
    );
  }
  const lexed = words(masked);
  const hit = lexed.find((word) => keywordSet.has(word));
  if (hit !== undefined) {
    return refuse(
      `The statement carries the keyword ${asciiUpper(hit)}, which starts another statement, writes, or runs outside this database.`,
      "Send one plain SELECT over this database's tables and views.",
    );
  }
  if (
    lexed.some(
      (word, at) =>
        word === "next" && lexed[at + 1] === "value" && lexed[at + 2] === "for",
    )
  ) {
    return refuse(
      "The statement draws NEXT VALUE FOR a sequence, which advances it even when the transaction is rolled back.",
      "Read the sequence's current_value from sys.sequences instead.",
    );
  }
  if (lexed.some((word) => /^(?:sp|xp)_/u.test(word))) {
    return refuse(
      "The statement names a system procedure.",
      "Use search_catalog and describe_table for catalogue questions.",
    );
  }
  return { verdict: "allow", statement: sqlText(sql) };
}
