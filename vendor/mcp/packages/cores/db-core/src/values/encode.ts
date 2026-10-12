import { truncateWellFormed } from "@sezzlee/mcp-core";
import type {
  ColumnKind,
  EncodedValue,
  JsonScalar,
  ValuePolicy,
} from "../model/value.js";

const truncatedText = (text: string, policy: ValuePolicy): EncodedValue =>
  text.length <= policy.maxTextChars
    ? { value: text }
    : { value: truncateWellFormed(text, policy.maxTextChars), truncated: true };

function encodeBinary(bytes: Uint8Array, policy: ValuePolicy): EncodedValue {
  const kept = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, policy.maxBinaryBytes),
  );
  return bytes.byteLength <= policy.maxBinaryBytes
    ? { value: kept.toString("base64") }
    : { value: kept.toString("base64"), truncated: true };
}

/**
 * Maps one driver cell to a JSON scalar.
 *
 * Guard: a value a driver already handed over as a `number` cannot be repaired
 * here. Measured: wide exact-numeric columns arrive as binary64 with their low
 * digits gone, while wide integers arrive as strings and survive. Rendering a
 * damaged number as a string would launder it into a form that claims precision,
 * so the loss is reported on the column by the dialect instead.
 * `NaN`/`Infinity` become null for the same reason: never invent a token the
 * engine did not send. Measured: `123456789012345678.1234` in a `decimal(38,4)`
 * column arrives as `123456789012345680`.
 */
export function encodeValue(
  raw: unknown,
  kind: ColumnKind,
  policy: ValuePolicy,
): EncodedValue {
  if (raw === null || raw === undefined) {
    return { value: null };
  }
  if (typeof raw === "bigint") {
    return { value: raw.toString() };
  }
  if (raw instanceof Date) {
    return {
      value: Number.isNaN(raw.getTime()) ? null : raw.toISOString(),
    };
  }
  if (raw instanceof Uint8Array) {
    return encodeBinary(raw, policy);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { value: null };
    }
    return kind === "bigint" ? { value: raw.toString() } : { value: raw };
  }
  if (typeof raw === "boolean") {
    return { value: raw };
  }
  if (typeof raw === "string") {
    return truncatedText(raw, policy);
  }
  return truncatedText(JSON.stringify(raw) ?? "null", policy);
}

export function encodeRow(
  row: readonly unknown[],
  kinds: readonly ColumnKind[],
  policy: ValuePolicy,
): readonly JsonScalar[] {
  return row.map(
    (cell, index) => encodeValue(cell, kinds[index] ?? "unknown", policy).value,
  );
}
