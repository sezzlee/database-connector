import { describe, expect, it } from "vitest";
import {
  baseSecretPatterns,
  encodeRow,
  encodeValue,
  redactSecrets,
  stableHash,
} from "../src/index.js";

const policy = { maxTextChars: 8, maxBinaryBytes: 4 };

describe("encodeValue", () => {
  it("renders a bigint as a string, never a number", () => {
    const wide = 9_007_199_254_740_993n;
    expect(encodeValue(wide, "bigint", policy)).toEqual({
      value: "9007199254740993",
    });
  });

  it("leaves a decimal the driver already handed over as a number alone", () => {
    expect(encodeValue(1.5, "decimal", policy)).toEqual({ value: 1.5 });
  });

  it("keeps an ordinary number a number", () => {
    expect(encodeValue(42, "integer", policy)).toEqual({ value: 42 });
  });

  it("maps a non-finite number to null rather than inventing a token", () => {
    expect(encodeValue(Number.NaN, "float", policy)).toEqual({ value: null });
    expect(encodeValue(Number.POSITIVE_INFINITY, "float", policy)).toEqual({
      value: null,
    });
  });

  it("renders a date as ISO-8601", () => {
    expect(encodeValue(new Date(0), "timestamp", policy)).toEqual({
      value: "1970-01-01T00:00:00.000Z",
    });
  });

  it("maps an invalid date to null", () => {
    expect(encodeValue(new Date("nope"), "timestamp", policy)).toEqual({
      value: null,
    });
  });

  it("base64-encodes binary and flags a cut", () => {
    const short = encodeValue(Uint8Array.from([1, 2, 3]), "binary", policy);
    expect(short).toEqual({ value: Buffer.from([1, 2, 3]).toString("base64") });
    const long = encodeValue(
      Uint8Array.from([1, 2, 3, 4, 5, 6]),
      "binary",
      policy,
    );
    expect(long.truncated).toBe(true);
    expect(Buffer.from(String(long.value), "base64")).toHaveLength(4);
  });

  it("never emits the Buffer JSON shape that would blow the payload gate", () => {
    const encoded = encodeValue(Buffer.from("ab"), "binary", policy);
    expect(JSON.stringify(encoded.value)).not.toContain('"type"');
  });

  it("truncates text on a well-formed boundary", () => {
    const encoded = encodeValue("😀😀😀😀😀", "text", policy);
    expect(encoded.truncated).toBe(true);
    expect(String(encoded.value).endsWith("\ud83d")).toBe(false);
  });

  it("maps null and undefined alike to null", () => {
    expect(encodeValue(null, "text", policy)).toEqual({ value: null });
    expect(encodeValue(undefined, "text", policy)).toEqual({ value: null });
  });
});

describe("encodeRow", () => {
  it("applies each column's kind by position and tolerates a short kind list", () => {
    expect(encodeRow([1n, "ab", 3], ["bigint", "text"], policy)).toEqual([
      "1",
      "ab",
      3,
    ]);
  });
});

describe("redactSecrets", () => {
  const redact = (text: string) => redactSecrets(text, baseSecretPatterns);

  it("keeps the key and drops the value of a password pair", () => {
    expect(redact("Server=db;Password=hunter2;Encrypt=true")).toBe(
      "Server=db;Password=[redacted];Encrypt=true",
    );
  });

  it("handles the brace-quoted form", () => {
    expect(redact("Password={p;w}d}")).toContain("Password=[redacted]");
  });

  it("removes url userinfo but keeps the host", () => {
    expect(redact("failed at mssql://sa:secret@db.internal:1433")).toBe(
      "failed at mssql://[redacted]@db.internal:1433",
    );
  });

  it("removes a bearer token and a jwt", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: [redacted]",
    );
    expect(redact("token eyJhbGciOiJIUzI1NiJ9")).toBe("token [redacted]");
  });

  it("leaves an innocent message alone", () => {
    expect(redact("Invalid object name 'Sales.Orders'.")).toBe(
      "Invalid object name 'Sales.Orders'.",
    );
  });

  it("never throws, whatever it is handed", () => {
    for (const text of ["", "=".repeat(500), "Password=", "://@", "\ud83d"]) {
      expect(() => redact(text)).not.toThrow();
    }
  });
});

describe("stableHash", () => {
  it("is stable, short and sensitive to the value", () => {
    expect(stableHash({ a: 1 })).toBe(stableHash({ a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });
});
