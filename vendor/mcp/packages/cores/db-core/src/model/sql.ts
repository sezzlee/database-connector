import type { ColumnDescriptor, ColumnKind, JsonScalar } from "./value.js";

declare const sqlTextBrand: unique symbol;
declare const identifierBrand: unique symbol;

/**
 * SQL text a dialect either built itself or passed through its read-only guard.
 *
 * Guard: db-core never concatenates one, and no tool handler can mint one. Agent
 * text becomes `SqlText` only through the `allow` arm of `Dialect.readOnlyGuard`,
 * which is what makes "run the guard before the statement" a type rule rather
 * than a convention.
 */
export type SqlText = string & { readonly [sqlTextBrand]: true };

/** An identifier already quoted for one dialect's grammar. */
export type QuotedIdentifier = string & { readonly [identifierBrand]: true };

/**
 * Guard: the only sanctioned way to mint `SqlText`. It belongs to the dialect
 * layer alone — a product package must keep it out of its tool surface, which
 * each product package's `oxlint.config.ts` enforces with `importNames`.
 */
export function sqlText(text: string): SqlText {
  return text as SqlText;
}

/**
 * Guard: the only sanctioned way to mint `QuotedIdentifier`. Calling it on text
 * that has not been through a dialect's quoting rule reopens injection through
 * an identifier, which no parameter binding can close.
 */
export function quotedIdentifier(text: string): QuotedIdentifier {
  return text as QuotedIdentifier;
}

export interface QueryParameter {
  readonly name: string;
  readonly value: JsonScalar;
  readonly kind?: ColumnKind;
}

export interface SqlFragment {
  readonly text: SqlText;
  readonly parameters: readonly QueryParameter[];
}

export interface QuerySpec {
  readonly sql: SqlText;
  readonly parameters: readonly QueryParameter[];
  readonly timeoutMs: number;
  /** Rows the driver is asked for. The payload budget may stop earlier. */
  readonly maxRows: number;
}

export interface QueryResult {
  readonly columns: readonly ColumnDescriptor[];
  readonly rows: readonly (readonly unknown[])[];
  /** True when the driver stopped at `maxRows`, not at the end of the result. */
  readonly more: boolean;
}
