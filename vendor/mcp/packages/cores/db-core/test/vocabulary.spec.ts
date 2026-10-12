import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asciiLower } from "@sezzlee/mcp-core";

const root = fileURLToPath(new URL("../src", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? sources(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

/**
 * Guard: the "no engine vocabulary" rule is about string literals, which
 * no-restricted-imports cannot see. A Postgres server reuses this package
 * unchanged only for as long as none of these words is in it.
 */
const forbidden = [
  "mssql",
  "tedious",
  "sql server",
  "t-sql",
  "tsql",
  "postgres",
  "pg_",
  "mysql",
  "oracle",
  "sqlite",
  "nvarchar",
  "varchar",
  "uniqueidentifier",
  "datetimeoffset",
  "information_schema",
  "sys.",
  "order by",
  "fetch next",
  "offset @",
  "select *",
  "select top",
  "@e965",
];

describe("db-core carries no engine vocabulary", () => {
  const files = sources(root);

  it("scans every source file", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const path of files) {
    it(`keeps ${path.slice(root.length + 1)} engine-free`, () => {
      const text = asciiLower(readFileSync(path, "utf8"));
      const hits = forbidden.filter((word) => text.includes(word));
      expect(hits).toEqual([]);
    });
  }
});
