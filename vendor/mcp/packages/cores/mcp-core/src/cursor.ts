import { createHash } from "node:crypto";

declare const fingerprintBrand: unique symbol;

export type Fingerprint = string & { readonly [fingerprintBrand]: true };

export interface CursorEnvelope<V extends 1 | 2 = 1> {
  readonly v: V;
  readonly f: Fingerprint;
}

export type Cursor<TPosition, V extends 1 | 2 = 1> = [
  Extract<keyof TPosition, keyof CursorEnvelope>,
] extends [never]
  ? CursorEnvelope<V> & TPosition
  : never;

/**
 * Identity over a key, a variant and a content digest.
 *
 * Guard: the digest covers every byte, which is what makes a content change
 * detectable when the source's own metadata is unchanged. The variant is part of
 * the identity so two different read options over the same bytes cannot share a
 * cursor.
 */
export function fingerprintFromDigest(
  key: string,
  digest: Uint8Array,
  variant = "",
): Fingerprint {
  return createHash("sha256")
    .update(JSON.stringify([key, variant]))
    .update("\0")
    .update(digest)
    .digest("hex") as Fingerprint;
}

export function contentFingerprint(
  key: string,
  bytes: Uint8Array,
  variant = "",
): Fingerprint {
  return fingerprintFromDigest(
    key,
    createHash("sha256").update(bytes).digest(),
    variant,
  );
}

export function encodeCursor<TCursor extends CursorEnvelope<1 | 2>>(
  cursor: TCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes a cursor to `unknown`: the caller owns the type guard.
 *
 * Guard: the length cap and charset check reject garbage before `JSON.parse`,
 * and the payload is never trusted — a cursor is validated, not authenticated.
 */
export function decodeCursorPayload(raw: string): unknown {
  if (raw.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function isFresh(
  cursor: CursorEnvelope<1 | 2>,
  current: Fingerprint,
): boolean {
  return cursor.f === current;
}
