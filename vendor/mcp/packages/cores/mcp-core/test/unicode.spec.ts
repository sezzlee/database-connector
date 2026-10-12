import { describe, expect, it } from "vitest";
import {
  asciiLower,
  asciiUpper,
  canonical,
  fold,
  truncateUtf8,
  truncateWellFormed,
} from "../src/unicode.js";

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormed(text: string): boolean {
  return !loneSurrogate.test(text);
}

describe("fold", () => {
  it("collapses the Turkish dotted and dotless I without a locale", () => {
    for (const variant of [
      "İSTANBUL",
      "ISTANBUL",
      "istanbul",
      "İstanbul",
      "ıstanbul",
    ]) {
      expect(fold(variant)).toBe("istanbul");
    }
  });

  it("strips Turkish diacritics", () => {
    expect(fold("ŞİŞLİ")).toBe("sisli");
    expect(fold("Şişli")).toBe("sisli");
    expect(fold("SISLI")).toBe("sisli");
    expect(fold("ÖĞRENCİ")).toBe("ogrenci");
    expect(fold("Gülşen")).toBe("gulsen");
  });

  it("expands the sharp s", () => {
    expect(fold("straße")).toBe("strasse");
    expect(fold("STRASSE")).toBe("strasse");
  });

  it("unifies composed and decomposed forms", () => {
    expect(fold("çay")).toBe(fold("çay".normalize("NFD")));
  });

  it("is idempotent", () => {
    for (const text of ["İSTANBUL", "straße", "Gülşen", "order"]) {
      expect(fold(fold(text))).toBe(fold(text));
    }
  });

  it("leaves ASCII digits and glob metacharacters alone", () => {
    expect(fold("q1/*.CSV?[İ]")).toBe("q1/*.csv?[i]");
    expect(fold("2026-01-15")).toBe("2026-01-15");
  });

  it("does not fold width", () => {
    expect(fold("ＡＢＣ")).not.toBe("abc");
  });

  it("handles the empty string", () => {
    expect(fold("")).toBe("");
  });
});

describe("canonical", () => {
  it("composes without folding case", () => {
    expect(canonical("çay".normalize("NFD"))).toBe("çay");
    expect(canonical("İSTANBUL")).toBe("İSTANBUL");
  });
});

describe("ascii casing", () => {
  it("only touches the ASCII range", () => {
    expect(asciiLower("Q1/SAMPLE.XLSX")).toBe("q1/sample.xlsx");
    expect(asciiLower("İSTANBUL")).toBe("İstanbul");
    expect(asciiUpper("ışık")).toBe("ışıK");
    expect(asciiUpper("abc")).toBe("ABC");
  });
});

describe("truncateWellFormed", () => {
  it("returns short strings unchanged", () => {
    expect(truncateWellFormed("abc", 10)).toBe("abc");
    expect(truncateWellFormed("abc", 3)).toBe("abc");
  });

  it("never leaves a lone surrogate", () => {
    const text = `${"x".repeat(511)}😀`;
    const cut = truncateWellFormed(text, 512);
    expect(cut).toHaveLength(511);
    expect(isWellFormed(cut)).toBe(true);
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
  });

  it("keeps a whole surrogate pair that fits", () => {
    const text = `${"x".repeat(510)}😀y`;
    const cut = truncateWellFormed(text, 512);
    expect(cut).toHaveLength(512);
    expect(isWellFormed(cut)).toBe(true);
    expect(cut.endsWith("😀")).toBe(true);
  });

  it("cuts plain text at the limit", () => {
    expect(truncateWellFormed("x".repeat(600), 512)).toHaveLength(512);
  });
});

describe("truncateUtf8", () => {
  const turkish = "İstanbul Şişli Öğrenci Ağırlığı";

  it("cuts where truncateWellFormed cannot, because the budget is bytes", () => {
    const text = "ğ".repeat(400);
    expect(truncateWellFormed(text, 512)).toHaveLength(400);
    expect(Buffer.byteLength(truncateWellFormed(text, 512), "utf8")).toBe(800);
    expect(
      Buffer.byteLength(truncateUtf8(text, 512), "utf8"),
    ).toBeLessThanOrEqual(512);
  });

  it("never splits a multi-byte sequence", () => {
    expect(truncateUtf8("Ş".repeat(10), 5)).toBe("ŞŞ");
  });

  it("never leaves a lone surrogate", () => {
    expect(truncateUtf8("xxx😀", 5)).toBe("xxx");
    expect(truncateUtf8("xxx😀", 7)).toBe("xxx😀");
  });

  it("keeps the longest well-formed prefix at every budget", () => {
    for (const text of [turkish, "😀a😀b", "plain ascii"]) {
      for (let limit = 0; limit <= 40; limit += 1) {
        const cut = truncateUtf8(text, limit);
        expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(limit);
        expect(text.startsWith(cut)).toBe(true);
        if (cut !== text) {
          const points = [...text];
          const next = points.slice(0, [...cut].length + 1).join("");
          expect(Buffer.byteLength(next, "utf8")).toBeGreaterThan(limit);
        }
      }
    }
  });

  it("returns nothing for a degenerate budget", () => {
    expect(truncateUtf8(turkish, 0)).toBe("");
    expect(truncateUtf8(turkish, -5)).toBe("");
  });
});
