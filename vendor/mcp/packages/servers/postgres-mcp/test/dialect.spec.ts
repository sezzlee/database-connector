import { describe, expect, it } from "vitest";
import { readOnlyGuard } from "../src/dialect/guard.js";
import { describeType } from "../src/dialect/types.js";
import { createIntrospection } from "../src/dialect/introspect.js";
import { quoteIdentifier } from "../src/dialect/quote.js";
import { fail } from "../src/platform/errors.js";
import { mapDriverError } from "../src/dialect/errors.js";

describe("PostgreSQL dialect", () => {
  it.each([
    ["canceling statement due to statement timeout", "query_timeout"],
    ["canceling statement due to user request", "query_cancelled"],
    ["canceling statement", "query_cancelled"],
  ])("distinguishes native 57014 cancellation reason: %s", (message, code) => {
    expect(
      mapDriverError(Object.assign(new Error(message), { code: "57014" })),
    ).toMatchObject({ code, engineCode: "57014", message });
  });
  it("classifies structural PostgreSQL statement timeout diagnostics", () => {
    expect(
      mapDriverError({
        code: "57014",
        message: "canceling statement due to statement timeout",
      }),
    ).toMatchObject({ code: "query_timeout" });
  });
  it("keeps explicit driver cancellation and deadline codes authoritative", () => {
    expect(
      mapDriverError(
        Object.assign(
          new Error("canceling statement due to statement timeout"),
          { code: "ECANCEL" },
        ),
      ),
    ).toMatchObject({ code: "query_cancelled" });
    expect(
      mapDriverError(
        Object.assign(new Error("canceling statement due to user request"), {
          code: "ETIMEOUT",
        }),
      ),
    ).toMatchObject({ code: "query_timeout" });
    expect(
      mapDriverError(
        Object.assign(new Error("statement timeout"), { code: "42601" }),
      ),
    ).toMatchObject({ code: "query_failed" });
  });
  it.each(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"])(
    "reports a rejected server certificate as a connection failure: %s",
    (code) => {
      const failure = mapDriverError(
        Object.assign(new Error("certificate rejected"), { code }),
      );
      expect(failure).toMatchObject({
        code: "connection_failed",
        engineCode: code,
      });
      expect(failure?.recovery).toMatch(/certificate/);
    },
  );
  it.each([
    ["25006", "write_not_permitted", /read-only transaction/],
    ["ETIMEOUT", "query_timeout", /timeoutMs/],
    ["57014", "query_cancelled", /call again/],
  ])(
    "answers %s with the next step for that failure",
    (code, mapped, nextStep) => {
      const failure = mapDriverError(
        Object.assign(new Error("refused"), { code }),
      );
      expect(failure?.code).toBe(mapped);
      expect(failure?.recovery).toMatch(nextStep);
    },
  );
  it("classifies unavailable databases without parsing message prose", () => {
    expect(
      mapDriverError(
        Object.assign(new Error("unavailable"), { code: "3D000" }),
      ),
    ).toMatchObject({ code: "database_unavailable", engineCode: "3D000" });
  });
  it.each([
    "select 1",
    "with x as (select 'delete') select * from x",
    "select $$;delete$$",
    'select "MixedCase" from "public"."Table";',
    "select id from sales.orders where status = 'open' and (total > 10 or vip)",
    "select * from (select id from sales.orders) t",
    "select a.id from sales.a a join sales.b b using (id)",
    "select cast(total as numeric(10,2)), total::varchar(20) from sales.orders",
    "select distinct on (customer_id) * from sales.orders order by customer_id, created_at desc",
    "select substring(name from 1 for 3) from sales.c",
    "select * from sales.orders where id = any (array[1,2])",
    "select case when (a > 1) then 1 end from sales.o",
    "select * from sales.o cross join lateral (select 1) l",
    "select array_length(tags, 1), jsonb_array_elements(data) from sales.o",
    "(select 1) union (select 2)",
    "select 1; /* x */ ;",
    "select pg_catalog.pg_advisory_xact_lock(1)",
    "select pg_catalog.set_config('search_path', 'public', false)",
    "select U&'d\\0061ta' as note",
    "select E'\\'; still one literal' as note",
    "select U&'d\\0061t;a' as note",
    "select E'first'\n'\\'' as note",
    "select E'first' -- note\r\n  'a\\'b' as note",
  ])("allows one query: %s", (sql) => {
    expect(readOnlyGuard(sql).verdict).toBe("allow");
  });
  it.each([
    ["select 1; select 2", "2 statements"],
    ["select 1 -- note\r; select 2", "2 statements"],
    ["copy t to stdout", "COPY"],
    ["set default_transaction_read_only=off", "SET"],
    ["explain analyze delete from t", "EXPLAIN"],
    ["select 1 /*", "not closed"],
    ["select 'x", "not closed"],
    ["select $tag$ x", "not closed"],
    ["select E'\\'; delete from t; --", "not closed"],
    ["-- nothing", "empty"],
    [
      "select pg_catalog.pg_terminate_backend(12345)",
      "signals another session",
    ],
    ['select "pg_cancel_backend"(12345)', "signals another session"],
    ["select pg_cancel_backend /* note */ (12345)", "signals another session"],
    ['select pg_catalog.U&"pg_c\\0061ncel_backend"(12345)', "Unicode-escaped"],
    [
      "select pg_catalog.query_to_xml('select pg_catalog.pg_cancel_' || 'backend(1)', false, false, '')",
      "runs SQL text",
    ],
    ["select * from ts_stat('select vector from docs.pages')", "runs SQL text"],
    [
      "select public.dblink_exec('dbname=x', 'delete from t')",
      "outside this transaction",
    ],
    ["select pg_advisory_lock(1)", "session lock"],
    ["select ée'\\' , pg_cancel_backend(1) --'", "signals another session"],
    [
      "select E'first'\n'\\'', pg_catalog.pg_cancel_backend(1) --'",
      "signals another session",
    ],
    [
      "select E'first'\r\n'\\'', pg_cancel_backend(1) --'",
      "signals another session",
    ],
    [
      "select E'first'\n-- note\n'\\'', pg_cancel_backend(1) --'",
      "signals another session",
    ],
    [
      "select E'first' -- note\n'\\'', pg_cancel_backend(1) --'",
      "signals another session",
    ],
  ])("refuses %s and says why", (sql, reason) => {
    expect(readOnlyGuard(sql)).toMatchObject({
      verdict: "refuse",
      reason: expect.stringContaining(reason),
    });
  });
  it("quotes exact identifiers and rejects NUL", () => {
    expect(quoteIdentifier('Mixed"Case', fail)).toBe('"Mixed""Case"');
    expect(() => quoteIdentifier("x\0", fail)).toThrow();
  });
  it("preserves PostgreSQL numeric and temporal native facts", () => {
    expect(describeType({ typeName: "int8" })).toMatchObject({
      kind: "bigint",
      precision: 19,
    });
    expect(
      describeType({ typeName: "numeric", precision: 40, scale: 12 }),
    ).toMatchObject({ kind: "decimal", precision: 40, scale: 12 });
    expect(describeType({ typeName: "timestamptz" })).toEqual({
      kind: "timestamptz",
    });
  });
  it("binds exact schema/name and pairs ordered catalog bounds", () => {
    const introspection = createIntrospection(1000, {
      maxColumns: 40,
      maxKeys: 20,
    });
    const columns = introspection.columns({ schema: "Sales", name: "Order" });
    expect(columns.spec.parameters.map((p) => p.value)).toEqual([
      "Sales",
      "Order",
    ]);
    expect(columns.spec.sql).toContain("n.nspname = $1");
    expect(
      introspection.catalogObjects({ maxObjects: 5, maxRows: 20 }).spec.sql,
    ).toContain('order by n.nspname collate "C", c.relname collate "C"');
    expect(
      introspection.catalogColumns({ maxObjects: 5, maxRows: 20 }).spec.sql,
    ).toContain('order by o.schema collate "C", o.name collate "C", a.attnum');
  });
});
