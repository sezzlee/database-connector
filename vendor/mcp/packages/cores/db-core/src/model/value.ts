export type ColumnKind =
  | "boolean"
  | "integer"
  | "bigint"
  | "decimal"
  | "float"
  | "text"
  | "binary"
  | "uuid"
  | "json"
  | "xml"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "unknown";

export type JsonScalar = string | number | boolean | null;

/** The engine's own type facts for one column, before classification. */
export interface NativeColumn {
  readonly typeName: string;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
}

/**
 * A conversion this engine's driver cannot perform intact. The column keeps its
 * true `kind` — the flag says the value beside it is less faithful than the kind
 * promises, which is the only honest thing to report once the loss happened
 * upstream of this package.
 */
export type LossKind = "precision" | "timezone" | "representation";

export interface ColumnDescriptor {
  readonly name: string;
  readonly ordinal: number;
  readonly kind: ColumnKind;
  /**
   * The engine's own type name, verbatim: this is the one place engine
   * vocabulary appears in db-core, as data flowing through rather than as a
   * literal in the source.
   */
  readonly nativeType: string;
  readonly nullable: boolean;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly lossy?: LossKind;
}

/**
 * What a dialect knows about one engine type once it has seen whatever facts the
 * source reported.
 *
 * Guard: the dialect completes these, it does not merely classify. A catalogue
 * and a result set report the same column differently — one may omit a precision
 * the engine defines by type — so leaving each caller to forward its own source's
 * fields is what lets two tools disagree about the same column.
 */
export interface TypeFacts {
  readonly kind: ColumnKind;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly lossy?: LossKind;
}

/**
 * Builds a column descriptor from the dialect's verdict.
 *
 * Guard: the only sanctioned constructor. Every path that produces a column —
 * a driver's result-set metadata, a catalogue query — goes through here, so the
 * two cannot drift.
 */
export function columnDescriptor(
  name: string,
  ordinal: number,
  nullable: boolean,
  nativeType: string,
  facts: TypeFacts,
): ColumnDescriptor {
  return {
    name,
    ordinal,
    kind: facts.kind,
    nativeType,
    nullable,
    ...(facts.maxLength === undefined ? {} : { maxLength: facts.maxLength }),
    ...(facts.precision === undefined ? {} : { precision: facts.precision }),
    ...(facts.scale === undefined ? {} : { scale: facts.scale }),
    ...(facts.lossy === undefined ? {} : { lossy: facts.lossy }),
  };
}

export interface ValuePolicy {
  readonly maxTextChars: number;
  readonly maxBinaryBytes: number;
}

export interface EncodedValue {
  readonly value: JsonScalar;
  readonly truncated?: true;
}
