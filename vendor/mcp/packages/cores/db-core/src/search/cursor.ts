import {
  contentFingerprint,
  decodeCursorPayload,
  encodeCursor,
  isFresh,
  type Cursor,
  type ErrorFactory,
  type Fingerprint,
} from "@sezzlee/mcp-core";
import type { DbErrorCode } from "../errors.js";

export interface CatalogPosition {
  readonly i: number;
}

export type CatalogCursor = Cursor<CatalogPosition, 1>;

/**
 * Guard: the snapshot digest and the search arguments both enter the identity.
 * A rebuilt index and a changed question are the two ways a position can mean
 * something else than it did, and neither is visible in the position itself.
 */
export function catalogFingerprint(
  catalog: string,
  digest: string,
  variant: string,
): Fingerprint {
  return contentFingerprint(catalog, Buffer.from(digest, "utf8"), variant);
}

export function encodeCatalogCursor(
  fingerprint: Fingerprint,
  position: number,
): string {
  return encodeCursor({ v: 1, f: fingerprint, i: position } as CatalogCursor);
}

function isCatalogCursor(value: unknown): value is CatalogCursor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate["v"] === 1 &&
    typeof candidate["f"] === "string" &&
    typeof candidate["i"] === "number" &&
    Number.isInteger(candidate["i"]) &&
    (candidate["i"] as number) >= 0
  );
}

export function decodeCatalogCursor(
  raw: string,
  current: Fingerprint,
  fail: ErrorFactory<DbErrorCode>,
  searchTool: string,
): number {
  const decoded = decodeCursorPayload(raw);
  if (!isCatalogCursor(decoded)) {
    throw fail(
      "invalid_cursor",
      "The cursor is not a token a previous search returned.",
      `Call ${searchTool} again without a cursor.`,
    );
  }
  if (!isFresh(decoded, current)) {
    throw fail(
      "stale_cursor",
      "The catalogue was read again, or the search arguments changed, since that cursor was issued.",
      `Call ${searchTool} again without a cursor to start from the first page.`,
    );
  }
  return decoded.i;
}
