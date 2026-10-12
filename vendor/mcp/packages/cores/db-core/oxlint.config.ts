import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { casing } from "@sezzlee/oxlint-config/casing";

const driverMessage =
  "db-core names no driver; the dialect and the driver adapter arrive by injection.";
const primitivesMessage =
  "primitives/ is the dependency-free leaf; it may not import another layer or a package.";
const modelMessage =
  "model/ carries the relational vocabulary as types only; it may not import a runtime layer.";
const valuesMessage =
  "values/ maps one cell to JSON; it never opens a connection and never assembles a page.";
const poolMessage =
  "pool/ owns connection lifetime; running a query, reading a catalogue and assembling a page are above it.";
const queryMessage =
  "query/ runs one statement through a lease; the catalogue and the tool surface are above it.";
const catalogMessage =
  "catalog/ asks the dialect's introspection questions; the tool surface is above it.";

/**
 * Guard: a driver would make the Dialect seam decorative — the whole point of
 * the split is that a Postgres server reuses this package unchanged.
 */
const drivers = [
  "mssql",
  "tedious",
  "pg",
  "pg-native",
  "postgres",
  "mysql2",
  "oracledb",
  "better-sqlite3",
  "sqlite3",
];

/**
 * Guard: the entrypoints are listed alongside the folder globs because
 * no-restricted-imports matches the specifier string, not the resolved module.
 * Without them a layer could reach anything through ../index.js and the rule
 * would never fire.
 */
const entrypoints = ["**/index.js", "**/source.js"];

const restrict = (
  message: string,
  { paths = [], folders = [] }: { paths?: string[]; folders?: string[] },
) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [...paths, ...drivers].map((name) => ({ name, message })),
      patterns: [{ group: [...folders, ...entrypoints], message }],
    },
  ],
});

const banDrivers = (message: string) => ({
  "no-restricted-imports": [
    "error",
    { paths: drivers.map((name) => ({ name, message })) },
  ],
});

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [
    ...casing,
    {
      files: ["src/**/*.ts"],
      rules: banDrivers(driverMessage),
    },
    {
      files: ["src/primitives/**/*.ts"],
      rules: restrict(primitivesMessage, {
        paths: ["@sezzlee/mcp-core"],
        folders: [
          "**/model/**",
          "**/values/**",
          "**/pool/**",
          "**/query/**",
          "**/catalog/**",
          "**/tools/**",
        ],
      }),
    },
    {
      files: ["src/model/**/*.ts"],
      rules: restrict(modelMessage, {
        folders: [
          "**/values/**",
          "**/pool/**",
          "**/query/**",
          "**/catalog/**",
          "**/tools/**",
        ],
      }),
    },
    {
      files: ["src/values/**/*.ts"],
      rules: restrict(valuesMessage, {
        folders: ["**/pool/**", "**/query/**", "**/catalog/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/pool/**/*.ts"],
      rules: restrict(poolMessage, {
        folders: [
          "**/values/**",
          "**/query/**",
          "**/catalog/**",
          "**/tools/**",
        ],
      }),
    },
    {
      files: ["src/query/**/*.ts"],
      rules: restrict(queryMessage, {
        folders: ["**/catalog/**", "**/tools/**"],
      }),
    },
    {
      files: ["src/catalog/**/*.ts"],
      rules: restrict(catalogMessage, { folders: ["**/tools/**"] }),
    },
  ],
});
