import { truncateUtf8 } from "./unicode.js";

export function measureJson(value: unknown): number {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text === undefined ? "null" : text, "utf8");
}

export interface PageBudgetSpec {
  readonly maxBytes: number;
  readonly reserveBytes: number;
}

export interface PageBudget {
  admit(...parts: readonly unknown[]): boolean;
  readonly admitted: number;
  readonly usedBytes: number;
  readonly refused: boolean;
}

export function createPageBudget(spec: PageBudgetSpec): PageBudget {
  let admitted = 0;
  let usedBytes = spec.reserveBytes;
  let refused = false;
  return {
    get admitted() {
      return admitted;
    },
    get usedBytes() {
      return usedBytes;
    },
    get refused() {
      return refused;
    },
    admit(...parts) {
      if (refused) {
        return false;
      }
      let cost = admitted === 0 ? 0 : 1;
      for (const part of parts) {
        cost += measureJson(part);
      }
      if (usedBytes + cost > spec.maxBytes) {
        refused = true;
        return false;
      }
      usedBytes += cost;
      admitted += 1;
      return true;
    },
  };
}

function boundaries(encoded: Buffer): number[] {
  const cuts = [0];
  for (let index = 1; index <= encoded.length; index += 1) {
    if (index === encoded.length || ((encoded[index] ?? 0) & 0xc0) !== 0x80) {
      cuts.push(index);
    }
  }
  return cuts;
}

export function clampJsonField<T>(
  text: string,
  maxBytes: number,
  build: (value: string) => T,
): string {
  if (measureJson(build(text)) <= maxBytes) {
    return text;
  }
  const encoded = Buffer.from(
    truncateUtf8(text, Math.max(0, maxBytes)),
    "utf8",
  );
  const cuts = boundaries(encoded);
  let low = 0;
  let high = cuts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = encoded.toString("utf8", 0, cuts[mid] ?? 0);
    if (measureJson(build(candidate)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return encoded.toString("utf8", 0, cuts[low] ?? 0);
}
