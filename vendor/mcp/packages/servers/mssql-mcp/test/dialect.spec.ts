import { describe, expect, it } from "vitest";
import { DbSourceError, type ErrorFactory } from "@sezzlee/db-core";
import type { DbErrorCode } from "@sezzlee/db-core";
import { describeType } from "../src/dialect/types.js";
import { mapDriverError } from "../src/dialect/errors.js";
import { readOnlyGuard } from "../src/dialect/guard.js";
import { quoteIdentifier, quoteQualified } from "../src/dialect/quote.js";
import { createMssqlDialect, mssqlDialect } from "../src/dialect/index.js";

const fail: ErrorFactory<DbErrorCode> = (code, message, recovery) =>
  new DbSourceError(code, message, recovery);

describe("quoteIdentifier", () => {
  it("doubles the closing bracket, which is the only escape", () => {
    expect(quoteIdentifier("a]b", fail)).toBe("[a]]b]");
    expect(quoteIdentifier("Orders", fail)).toBe("[Orders]");
  });

  it("refuses an identifier that could not survive quoting", () => {
    expect(() => quoteIdentifier("", fail)).toThrow();
    expect(() => quoteIdentifier("a".repeat(129), fail)).toThrow();
    expect(() => quoteIdentifier("a\u0000b", fail)).toThrow();
  });

  it("qualifies both halves", () => {
    expect(quoteQualified({ schema: "dbo", name: "Or]ders" }, fail)).toBe(
      "[dbo].[Or]]ders]",
    );
  });
});

describe("describeType", () => {
  const kindOf = (typeName: string) => describeType({ typeName }).kind;

  it("answers both vocabularies for the same column", () => {
    expect(kindOf("NVarChar")).toBe("text");
    expect(kindOf("nvarchar")).toBe("text");
  });

  it("maps the exact-numeric family to decimal and the wide integer to bigint", () => {
    for (const name of ["decimal", "numeric", "money", "smallmoney"]) {
      expect(kindOf(name)).toBe("decimal");
    }
    expect(kindOf("bigint")).toBe("bigint");
    expect(kindOf("int")).toBe("integer");
  });

  it("separates the two timestamp families", () => {
    expect(kindOf("datetime2")).toBe("timestamp");
    expect(kindOf("datetimeoffset")).toBe("timestamptz");
  });

  it("falls back to unknown rather than guessing", () => {
    expect(kindOf("")).toBe("unknown");
    expect(kindOf("MyClrType")).toBe("unknown");
  });

  /**
   * Guard: T-SQL `timestamp` is `rowversion`, not a point in time. Calling it a
   * timestamp would hand the agent a date it can neither compare nor order.
   */
  it("keeps timestamp in the binary family, where T-SQL puts it", () => {
    expect(kindOf("timestamp")).toBe("binary");
    expect(kindOf("rowversion")).toBe("binary");
    expect(kindOf("datetime")).toBe("timestamp");
  });

  it("reads hierarchyid through both vocabularies, since the driver renames it", () => {
    expect(kindOf("hierarchyid")).toBe("binary");
    expect(kindOf("UDT")).toBe("binary");
  });

  it("reaches the json kind, which only the native type produces", () => {
    expect(kindOf("json")).toBe("json");
  });

  /**
   * Guard: the driver decodes a spatial value into an object of its own, which
   * the value encoder can only stringify. Flagging the column is what keeps a
   * truncated projection from reading as the value itself.
   */
  it("flags the spatial types as reshaped rather than typing the projection", () => {
    for (const name of ["geography", "Geography", "geometry", "Geometry"]) {
      expect(describeType({ typeName: name })).toMatchObject({
        kind: "unknown",
        lossy: "representation",
      });
    }
  });

  /**
   * Guard: `sql_variant` carries a different type in every row, so no static
   * kind is true of the column. `vector` has no measured driver shape. Both stay
   * unknown deliberately, and this test is what records that.
   */
  it("leaves the two genuinely unclassifiable types unknown and unflagged", () => {
    for (const name of ["sql_variant", "Variant", "vector"]) {
      const facts = describeType({ typeName: name });
      expect(facts.kind).toBe("unknown");
      expect(facts.lossy).toBeUndefined();
    }
  });

  /**
   * Guard: the catalogue reports money's precision, a result set does not. Both
   * had to reach the same verdict or one tool would call a column safe while
   * the other called it damaged.
   */
  it("fills the precision T-SQL fixes by type, whatever the source reported", () => {
    expect(describeType({ typeName: "Money" })).toMatchObject({
      precision: 19,
      scale: 4,
      lossy: "precision",
    });
    expect(
      describeType({ typeName: "money", precision: 19, scale: 4 }),
    ).toMatchObject({ precision: 19, scale: 4, lossy: "precision" });
  });

  it("agrees on money whether the precision came from the driver or the catalogue", () => {
    const fromDriver = describeType({ typeName: "Money" });
    const fromCatalogue = describeType({
      typeName: "money",
      precision: 19,
      scale: 4,
    });
    expect(fromDriver).toEqual(fromCatalogue);
  });

  it("leaves smallmoney unflagged, because ten digits fit", () => {
    const facts = describeType({ typeName: "smallmoney" });
    expect(facts.precision).toBe(10);
    expect(facts.lossy).toBeUndefined();
  });

  it("flags a wide decimal and spares a narrow one", () => {
    expect(describeType({ typeName: "decimal", precision: 38 }).lossy).toBe(
      "precision",
    );
    expect(describeType({ typeName: "decimal", precision: 15 }).lossy).toBe(
      undefined,
    );
  });

  it("does not mistake float's bit precision for decimal digits", () => {
    expect(describeType({ typeName: "float", precision: 53 }).lossy).toBe(
      undefined,
    );
    expect(describeType({ typeName: "bigint", precision: 19 }).lossy).toBe(
      undefined,
    );
  });

  it("keeps datetimeoffset zone-aware but reports the zone the driver drops", () => {
    expect(describeType({ typeName: "DateTimeOffset" })).toMatchObject({
      kind: "timestamptz",
      lossy: "timezone",
    });
  });
});

describe("readOnlyGuard", () => {
  const allows = (sql: string) => readOnlyGuard(sql).verdict === "allow";

  it("allows a plain select and a common table expression", () => {
    expect(allows("select 1")).toBe(true);
    expect(allows("  SELECT * FROM dbo.Orders  ")).toBe(true);
    expect(allows("with x as (select 1 as n) select n from x")).toBe(true);
  });

  it("allows a trailing semicolon but refuses a batch", () => {
    expect(allows("select 1;")).toBe(true);
    expect(allows("select 1; drop table dbo.Orders")).toBe(false);
  });

  it("refuses anything that does not begin with SELECT or WITH", () => {
    for (const sql of [
      "delete from dbo.Orders",
      "update dbo.Orders set a = 1",
      "exec sp_who",
      "drop table dbo.Orders",
    ]) {
      expect(allows(sql)).toBe(false);
    }
  });

  it("reads a name that runs through digits as one identifier", () => {
    expect(allows('select a1delete, [sp_x], "a""delete" from dbo.Orders')).toBe(
      true,
    );
  });

  it("allows a query that opens with a parenthesis", () => {
    expect(allows("(select 1) union (select 2)")).toBe(true);
  });

  it("does not trip on a keyword inside a string literal", () => {
    expect(allows("select 'drop me' as note")).toBe(true);
    expect(allows("select 'it''s a delete' as note")).toBe(true);
  });

  it("does not trip on a keyword inside a bracketed identifier", () => {
    expect(allows("select [delete] from dbo.Orders")).toBe(true);
  });

  it("strips comments before looking, in both forms", () => {
    expect(allows("-- drop table t\nselect 1")).toBe(true);
    expect(allows("select 1 /* drop table t */")).toBe(true);
  });

  it("refuses a statement that is only a comment", () => {
    expect(allows("-- nothing here")).toBe(false);
    expect(allows("   ")).toBe(false);
  });

  it.each([
    ["select 1 delete from dbo.Orders", "DELETE"],
    ["select [x]delete from dbo.Orders", "DELETE"],
    ["select 1delete from dbo.Orders", "DELETE"],
    ["select 1edelete from dbo.Orders", "DELETE"],
    ["select 1 -- note\rdelete from dbo.Orders", "DELETE"],
    ["select 1 -- note\u2028delete from dbo.Orders", "DELETE"],
    ["select 1 \u0130NSERT dbo.Orders values (1)", "INSERT"],
    ["select 1 \uff24\uff25\uff2c\uff25\uff34\uff25 from dbo.Orders", "DELETE"],
    ["select 1 writetext dbo.Orders.Notes @p 'x'", "WRITETEXT"],
    ["select next value for dbo.review_seq", "NEXT VALUE FOR"],
    ["select NEXT /* x */ VALUE\nFOR dbo.review_seq as n", "NEXT VALUE FOR"],
    ["select 1 de\u200blete from dbo.Orders", "invisible"],
    ["select 1 del\u0000ete from dbo.Orders", "control"],
    ["select 1 \ufeffdelete from dbo.Orders", "invisible"],
    ["select 1 exec('drop table dbo.Orders')", "EXEC"],
    ["with x as (select 1 as n) delete from dbo.Orders", "DELETE"],
    ["select * into #t from dbo.Orders", "INTO"],
    ["select 1 where 1 = 0 waitfor delay '00:10:00'", "WAITFOR"],
    ["select * from openquery(Linked, 'delete from dbo.Orders')", "OPENQUERY"],
    [
      "select * from openrowset('SQLNCLI', 'Server=x;', 'select 1') as r",
      "OPENROWSET",
    ],
  ])(
    "refuses %s, a second statement or an escape T-SQL needs no semicolon for",
    (sql, keyword) => {
      expect(readOnlyGuard(sql)).toMatchObject({
        verdict: "refuse",
        reason: expect.stringContaining(keyword),
      });
    },
  );

  it("refuses a system procedure by prefix", () => {
    expect(allows("select * from sp_helpsomething()")).toBe(false);
  });

  it("names the statement it refused, so the agent can fix it", () => {
    const outcome = readOnlyGuard("exec sp_who");
    expect(outcome.verdict).toBe("refuse");
    if (outcome.verdict === "refuse") {
      expect(outcome.reason).toContain("EXEC");
      expect(outcome.recovery.length).toBeGreaterThan(0);
    }
  });
});

describe("mapDriverError", () => {
  it("reads the number for a server-side fault", () => {
    expect(
      mapDriverError({
        code: "EREQUEST",
        number: 208,
        message: "Invalid object name 'x'.",
      }),
    ).toMatchObject({ code: "object_not_found", engineCode: 208 });
  });

  it("treats an unrecognised first word as a user error, not a server fault", () => {
    expect(
      mapDriverError({ code: "EREQUEST", number: 2812, message: "..." }),
    ).toMatchObject({ code: "invalid_argument" });
  });

  it("reads the code for a connection-level fault", () => {
    expect(
      mapDriverError({ code: "ECANCEL", message: "Canceled." }),
    ).toMatchObject({ code: "query_cancelled" });
    expect(mapDriverError({ code: "ESOCKET", message: "..." })).toMatchObject({
      code: "connection_failed",
    });
    expect(mapDriverError({ code: "ELOGIN", message: "..." })).toMatchObject({
      code: "authentication_failed",
    });
  });

  it("names a next step for every failure it maps", () => {
    for (const failure of [
      { code: "ETIMEOUT", message: "..." },
      { code: "ECANCEL", message: "..." },
      { code: "EREQUEST", number: 99999, message: "..." },
    ]) {
      expect(mapDriverError(failure)?.recovery ?? "").not.toBe("");
    }
  });

  it("falls back to query_failed for an unmapped server number", () => {
    expect(
      mapDriverError({ code: "EREQUEST", number: 99999, message: "..." }),
    ).toMatchObject({ code: "query_failed" });
  });

  it("returns undefined for something that is not a driver error", () => {
    expect(
      mapDriverError(new TypeError("x is not a function")),
    ).toBeUndefined();
    expect(mapDriverError("boom")).toBeUndefined();
    expect(mapDriverError(null)).toBeUndefined();
  });
});

describe("the dialect as a whole", () => {
  it("reports no session-level read-only guarantee, because there is none", () => {
    expect(mssqlDialect.sessionIntent()).toBe("none");
  });

  it("opens every connection with a lock timeout", () => {
    const setup = mssqlDialect.sessionSetup();
    expect(setup).toHaveLength(1);
    expect(setup[0]?.sql).toContain("lock_timeout");
  });

  it("sets the lock timeout from the connection's query deadline", () => {
    expect(createMssqlDialect(5_000).sessionSetup()[0]?.sql).toContain(
      "lock_timeout 5000;",
    );
  });

  it("carries connection-string patterns beyond the core's", () => {
    expect(mssqlDialect.secretPatterns.length).toBeGreaterThan(4);
  });
});
