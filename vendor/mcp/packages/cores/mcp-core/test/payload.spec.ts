import { describe, expect, it } from "vitest";
import {
  clampJsonField,
  createPageBudget,
  measureJson,
} from "../src/payload.js";

const turkish = "İstanbul Şişli Öğrenci Ağırlığı";

describe("measureJson", () => {
  it("counts utf-8 bytes, not utf-16 code units", () => {
    expect(turkish.length).toBe(31);
    expect(measureJson(turkish)).toBe(43);
  });

  it("agrees with a direct serialisation for every shape", () => {
    const shapes: unknown[] = [
      null,
      0,
      false,
      "",
      turkish,
      "😀".repeat(10),
      { a: [1, 2, 3], b: { c: turkish } },
    ];
    for (const shape of shapes) {
      expect(measureJson(shape)).toBe(
        Buffer.byteLength(JSON.stringify(shape), "utf8"),
      );
    }
  });

  it("treats an undefined value the way an array member is serialised", () => {
    expect(measureJson(undefined)).toBe(4);
    expect(measureJson([undefined])).toBe(measureJson([null]));
  });

  it("measures a lone surrogate through its escaped form", () => {
    expect(measureJson("\ud83d")).toBe(8);
  });
});

describe("the page budget", () => {
  const envelope = (items: readonly unknown[]) => ({
    sheet: "one",
    items,
    truncated: true,
  });

  it("models the packed size as an exact equality", () => {
    const items = ["aa", "bbb", turkish, "😀"];
    const reserveBytes = measureJson(envelope([]));
    const budget = createPageBudget({ maxBytes: 10_000, reserveBytes });
    for (const item of items) {
      expect(budget.admit(item)).toBe(true);
    }
    expect(budget.usedBytes).toBe(measureJson(envelope(items)));
  });

  it("fills a page to the byte and no further", () => {
    const items = ["aa", "bbb", "cccc"];
    const maxBytes = measureJson(envelope(items));
    const budget = createPageBudget({
      maxBytes,
      reserveBytes: measureJson(envelope([])),
    });
    const admitted: unknown[] = [];
    for (const item of [...items, "d"]) {
      if (budget.admit(item)) {
        admitted.push(item);
      }
    }
    expect(admitted).toEqual(items);
    expect(measureJson(envelope(admitted))).toBe(maxBytes);
  });

  it("admits one item when the reserve leaves room for exactly one", () => {
    const budget = createPageBudget({
      maxBytes: measureJson(envelope([])) + measureJson("aa"),
      reserveBytes: measureJson(envelope([])),
    });
    expect(budget.admit("aa")).toBe(true);
    expect(budget.admit("b")).toBe(false);
    expect(budget.admitted).toBe(1);
  });

  it("reports a refusal without charging anything when the first item overflows", () => {
    const reserveBytes = measureJson(envelope([]));
    const budget = createPageBudget({ maxBytes: reserveBytes, reserveBytes });
    expect(budget.admit("aa")).toBe(false);
    expect(budget.admitted).toBe(0);
    expect(budget.refused).toBe(true);
    expect(budget.usedBytes).toBe(reserveBytes);
  });

  it("stays refused so a later small item cannot slip past a rejected one", () => {
    const budget = createPageBudget({ maxBytes: 200, reserveBytes: 0 });
    expect(budget.admit("a")).toBe(true);
    expect(budget.admit("x".repeat(500))).toBe(false);
    expect(budget.admit("b")).toBe(false);
    expect(budget.admitted).toBe(1);
  });

  it("charges every part of a multi-part record and one separator", () => {
    const budget = createPageBudget({ maxBytes: 10_000, reserveBytes: 0 });
    budget.admit("a");
    const before = budget.usedBytes;
    budget.admit("bb", { c: 1 });
    expect(budget.usedBytes - before).toBe(
      1 + measureJson("bb") + measureJson({ c: 1 }),
    );
  });
});

describe("clampJsonField", () => {
  const shape = (message: string) => ({ error: "internal_error", message });

  it("returns the text untouched when it already fits", () => {
    expect(clampJsonField(turkish, 1000, shape)).toBe(turkish);
  });

  it("clamps so the built envelope lands under the limit", () => {
    const limit = 60;
    const kept = clampJsonField("😀".repeat(200), limit, shape);
    expect(measureJson(shape(kept))).toBeLessThanOrEqual(limit);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("keeps the longest prefix that fits", () => {
    const text = "abcdefghij";
    const floor = measureJson(shape(""));
    for (let limit = floor; limit <= floor + 12; limit += 1) {
      const kept = clampJsonField(text, limit, shape);
      expect(text.startsWith(kept)).toBe(true);
      expect(measureJson(shape(kept))).toBeLessThanOrEqual(limit);
      if (kept !== text) {
        expect(
          measureJson(shape(text.slice(0, kept.length + 1))),
        ).toBeGreaterThan(limit);
      }
    }
  });

  it("never splits a multi-byte sequence", () => {
    for (let limit = measureJson(shape("")); limit <= 80; limit += 1) {
      const kept = clampJsonField(turkish, limit, shape);
      expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
    }
  });

  it("collapses to an empty field when nothing fits", () => {
    expect(clampJsonField("boom", 10, shape)).toBe("");
  });

  it("lets the structural floor win over an impossible budget", () => {
    const kept = clampJsonField("boom", 5, shape);
    expect(kept).toBe("");
    expect(measureJson(shape(kept))).toBe(39);
  });
});
