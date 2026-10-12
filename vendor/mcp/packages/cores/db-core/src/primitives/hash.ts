import { createHash } from "node:crypto";

/**
 * A short, stable digest of any JSON-serialisable value. Used to pin the
 * arguments a cursor was issued against, so a changed argument invalidates it
 * instead of silently paging a different question.
 */
export function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  return createHash("sha256")
    .update(text === undefined ? "null" : text)
    .digest("hex")
    .slice(0, 16);
}
