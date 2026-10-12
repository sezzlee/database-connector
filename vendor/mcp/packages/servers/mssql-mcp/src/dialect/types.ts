import {
  asciiLower,
  type ColumnKind,
  type LossKind,
  type NativeColumn,
  type TypeFacts,
} from "@sezzlee/db-core";

/**
 * Guard: the same column is named twice by two vocabularies — the driver reports
 * `NVarChar` from a result set, the catalogue reports `nvarchar` from
 * `sys.types`. Folding to lower ASCII is what lets one table answer both; a
 * locale-dependent fold would break the dotted I on a Turkish system.
 *
 * The names are the normative T-SQL type list ("Data types (Transact-SQL)" on
 * learn.microsoft.com), not the set one database happened to contain.
 * `sql_variant` and `vector` are absent on purpose: the first carries a
 * different type in every row, the second is a SQL Server 2025 type whose
 * tedious@18 shape is unmeasured, so both are honestly `unknown`.
 */
const kinds: Readonly<Record<string, ColumnKind>> = {
  bit: "boolean",
  tinyint: "integer",
  smallint: "integer",
  int: "integer",
  bigint: "bigint",
  decimal: "decimal",
  numeric: "decimal",
  money: "decimal",
  smallmoney: "decimal",
  float: "float",
  real: "float",
  char: "text",
  nchar: "text",
  varchar: "text",
  nvarchar: "text",
  text: "text",
  ntext: "text",
  sysname: "text",
  binary: "binary",
  varbinary: "binary",
  image: "binary",
  timestamp: "binary",
  rowversion: "binary",
  /**
   * Guard: the root node is a zero-length value, so an empty base64 string is
   * the value itself, not a loss.
   */
  hierarchyid: "binary",
  /**
   * Guard: the driver renames a UDT column from TDS `udtInfo.typeName`, so
   * `geography`/`geometry` arrive by name while `hierarchyid` and every CLR type
   * arrive as `UDT`, all as bytes. On the catalogue path a CLR type keeps its
   * own name and falls to `unknown`; that asymmetry is accepted.
   */
  udt: "binary",
  uniqueidentifier: "uuid",
  json: "json",
  xml: "xml",
  date: "date",
  time: "time",
  datetime: "timestamp",
  datetime2: "timestamp",
  smalldatetime: "timestamp",
  datetimeoffset: "timestamptz",
};

/**
 * Guard: T-SQL fixes these by type, but a result set does not report them —
 * measured, the driver sends `Money` with no precision at all, while
 * `sys.columns` sends 19. Filling them here is what stops `run_query` and
 * `describe_table` from disagreeing about the same column.
 */
const fixed: Readonly<
  Record<string, { readonly precision: number; readonly scale: number }>
> = {
  money: { precision: 19, scale: 4 },
  smallmoney: { precision: 10, scale: 4 },
};

/**
 * Guard: measured, the driver decodes these into an object of its own shape
 * instead of handing over the value, so `encodeValue` stringifies that object
 * and a shape with many points truncates into invalid JSON at the text budget.
 * The kind stays `unknown` because the object is the driver's projection, not
 * the spatial value; `STAsText()` in the query is the agent's way out.
 */
const reshaped: ReadonlySet<string> = new Set(["geography", "geometry"]);

/**
 * Guard: binary64 carries fifteen significant decimal digits. A wider exact
 * numeric is already damaged by the time this package sees it, because the
 * driver hands it over as a `number`. The threshold is the format's; whether it
 * bites is this driver's, which is why the verdict lives in the dialect and not
 * in `@sezzlee/db-core`.
 */
const SAFE_DIGITS = 15;

/**
 * Guard: `datetimeoffset` is genuinely zone-aware, so the kind stays
 * `timestamptz` — but the driver flattens it to a `Date`, which carries no zone.
 * Reporting the loss is the only honest option left once it happened upstream.
 */
function lossOf(
  name: string,
  kind: ColumnKind,
  precision: number | undefined,
): LossKind | undefined {
  if (reshaped.has(name)) {
    return "representation";
  }
  if (kind === "timestamptz") {
    return "timezone";
  }
  return kind === "decimal" &&
    precision !== undefined &&
    precision > SAFE_DIGITS
    ? "precision"
    : undefined;
}

export function describeType(native: NativeColumn): TypeFacts {
  const name = asciiLower(native.typeName);
  const kind = kinds[name] ?? "unknown";
  const defaults = fixed[name];
  const precision = native.precision ?? defaults?.precision;
  const scale = native.scale ?? defaults?.scale;
  const lossy = lossOf(name, kind, precision);

  return {
    kind,
    ...(native.maxLength === undefined ? {} : { maxLength: native.maxLength }),
    ...(precision === undefined ? {} : { precision }),
    ...(scale === undefined ? {} : { scale }),
    ...(lossy === undefined ? {} : { lossy }),
  };
}
