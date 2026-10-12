import { describe, expect, it } from "vitest";
import { tokenize } from "../src/search/tokenize.js";
import { likeMatches } from "../src/search/pattern.js";
import { buildIndex, type IndexedDocument } from "../src/search/inverted.js";
import { rank } from "../src/search/rank.js";

const spec = { maxTerms: 16, maxExpansions: 32, maxReasons: 8 };

const object = (
  schema: string,
  name: string,
  columns: readonly string[],
  description?: string,
): IndexedDocument => ({
  schema,
  name,
  ...(description === undefined ? {} : { description }),
  columns: columns.map((column) => ({ name: column })),
});

describe("tokenize", () => {
  const terms = (text: string) => [...tokenize(text)];

  it("splits on the separator and on the camel boundary", () => {
    expect(terms("VPOS_Islem_No")).toEqual(["vpos", "islem", "no"]);
    expect(terms("CreatedBy")).toEqual(["createdby", "created", "by"]);
  });

  /**
   * Guard: an all-capital compound carries no boundary, so only the undivided
   * token reaches the index. Dropping it would file `CREATEDBY_ID` and
   * `CreatedBy` under terms that never meet.
   */
  it("gives both naming styles the undivided term", () => {
    expect(terms("CREATEDBY_ID")).toContain("createdby");
    expect(terms("CreatedBy")).toContain("createdby");
  });

  it("separates an acronym from the word that follows it", () => {
    expect(terms("XMLParser")).toEqual(["xmlparser", "xml", "parser"]);
  });

  it("cuts between letters and digits", () => {
    expect(terms("Address2Line")).toEqual([
      "address2line",
      "address",
      "2",
      "line",
    ]);
  });

  /**
   * Guard: measured, not assumed. All four Turkish I forms fold to `i`, so a
   * query typed on an ASCII keyboard reaches a name that is not. The sample
   * database carries no such name; another deployment will.
   */
  it("folds every Turkish form of the letter I onto one term", () => {
    for (const name of ["İl", "Il", "il", "ıl"]) {
      expect(terms(name)).toEqual(["il"]);
    }
  });

  it("strips diacritics so an ASCII query reaches the name that carries them", () => {
    expect(terms("MüşteriAdı")).toEqual(["musteriadi", "musteri", "adi"]);
    expect(terms("ÇağrıNo")).toEqual(["cagrino", "cagri", "no"]);
  });

  it("returns nothing for text with no letters or digits", () => {
    expect(terms("___")).toEqual([]);
    expect(terms("")).toEqual([]);
  });
});

describe("likeMatches", () => {
  it("reads % as any run and _ as exactly one", () => {
    expect(likeMatches("VPOS%", "VPOS_Islem")).toBe(true);
    expect(likeMatches("%Islem%", "VPOS_Islem")).toBe(true);
    expect(likeMatches("VPOS_____", "VPOS_Isle")).toBe(true);
    expect(likeMatches("VPOS_", "VPOS_Islem")).toBe(false);
  });

  it("matches case and diacritics insensitively, on both sides", () => {
    expect(likeMatches("%musteri%", "MüşteriAdı")).toBe(true);
    expect(likeMatches("%MÜŞTERİ%", "musteriadi")).toBe(true);
  });

  it("does not backtrack on a pattern built to make it", () => {
    const pattern = `${"%a".repeat(24)}%b`;
    const started = Date.now();
    expect(likeMatches(pattern, "a".repeat(200))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("the inverted index", () => {
  const documents = [
    object("dbo", "INV_Invoices", ["InvoiceId", "VendorId", "CreatedBy"]),
    object("dbo", "VND_Vendors", ["VendorId", "VendorName", "CreatedBy"]),
    object("crm", "CRM_Contacts", ["ContactId", "CreatedBy"]),
  ];
  const index = buildIndex(documents);

  it("counts documents, not postings, as the frequency", () => {
    expect(index.documents).toBe(3);
    expect(index.frequency("createdby")).toBe(3);
    expect(index.frequency("vendorid")).toBe(2);
    expect(index.frequency("invoiceid")).toBe(1);
  });

  it("expands a prefix to the longer terms, rarest first", () => {
    const found = index.expand("vendor", 32).map((entry) => entry.term);
    expect(found).toContain("vendorname");
    expect(found).toContain("vendorid");
    expect(found.indexOf("vendorname")).toBeLessThan(found.indexOf("vendorid"));
  });

  it("never expands a term to itself", () => {
    expect(index.expand("createdby", 32).map((e) => e.term)).not.toContain(
      "createdby",
    );
  });
});

describe("rank", () => {
  const documents = [
    object("dbo", "INV_Invoices", ["InvoiceId", "VendorId", "CreatedBy"]),
    object("dbo", "VND_Vendors", ["VendorId", "VendorName", "CreatedBy"]),
    object("crm", "CRM_Contacts", ["ContactId", "CreatedBy"], "Tedarikçi ile"),
  ];
  const index = buildIndex(documents);

  it("puts the name hit above the column hit for the same term", () => {
    const found = rank(index, "vendors", spec);
    expect(found[0]?.document).toBe(1);
  });

  /**
   * Guard: a term every document carries must not outweigh a rare one. This is
   * the whole reason IDF is here and `k1`/`b` are not.
   */
  it("scores a term in every document below one in a single document", () => {
    const common = rank(index, "createdby", spec)[0]?.score ?? 0;
    const rare = rank(index, "invoiceid", spec)[0]?.score ?? 0;
    expect(rare).toBeGreaterThan(common);
  });

  /**
   * Guard: `CREATEDBY_ID` carries no boundary to split on, so `createdby` is the
   * only term it ever produces. Without prefix matching the query `create`
   * cannot reach it, and the same concept spelled `CreatedBy` would be found
   * while this one stayed invisible.
   */
  it("reaches an all-capital compound, which only a prefix can find", () => {
    const shouting = buildIndex([object("dbo", "AUDIT_Log", ["CREATEDBY_ID"])]);
    expect(shouting.exact("created")).toEqual([]);
    const found = rank(shouting, "create", spec);
    expect(found.length).toBe(1);
    expect(found[0]?.matched[0]?.term).toBe("createdby");
  });

  it("scores a prefix hit below the exact term", () => {
    const exact = rank(index, "vendorname", spec)[0]?.score ?? 0;
    const prefix = rank(index, "vendornam", spec)[0]?.score ?? 0;
    expect(prefix).toBeLessThan(exact);
    expect(prefix).toBeGreaterThan(0);
  });

  it("reads a description, not only an identifier", () => {
    const found = rank(index, "tedarikci", spec);
    expect(found[0]?.document).toBe(2);
    expect(found[0]?.matched[0]?.field).toBe("description");
  });

  it("counts a term once per field however many columns repeat it", () => {
    const wide = buildIndex([object("dbo", "T", ["AId", "ABId", "ACId"])]);
    const narrow = buildIndex([object("dbo", "T", ["AId"])]);
    expect(rank(wide, "aid", spec)[0]?.score).toBe(
      rank(narrow, "aid", spec)[0]?.score,
    );
  });

  it("breaks a score tie on catalog order, so the page is deterministic", () => {
    const found = rank(index, "createdby", spec);
    expect(found.map((entry) => entry.document)).toEqual([0, 1, 2]);
  });

  it("returns nothing for a term the catalogue does not carry", () => {
    expect(rank(index, "nosuchterm", spec)).toEqual([]);
  });

  it("caps the reasons it reports", () => {
    const found = rank(index, "vendor id name created by invoice", {
      ...spec,
      maxReasons: 2,
    });
    for (const candidate of found) {
      expect(candidate.matched.length).toBeLessThanOrEqual(2);
    }
  });
});
