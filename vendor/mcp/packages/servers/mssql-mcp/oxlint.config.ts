import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import {
  casingProperties,
  processEnvProperty,
  restrictProperties,
} from "@sezzlee/oxlint-config/casing";

const platformMessage =
  "The platform layer is the db-core and node boundary; it may not import a layer above it.";
const dialectMessage =
  "A dialect is portable T-SQL knowledge; it never names a driver and never reaches the MCP surface.";
const driverMessage =
  "The driver adapter opens sockets and streams rows; it never builds SQL and never shapes a response.";

const driverPackages = ["mssql", "tedious"];
const serverPackages = ["@modelcontextprotocol/server"];

const sqlMinters = {
  name: "@sezzlee/db-core",
  importNames: ["sqlText", "quotedIdentifier"],
  message:
    "Minting SqlText or a QuotedIdentifier belongs to the dialect layer; everywhere else they arrive already built.",
};

/**
 * Guard: the entrypoints are listed alongside the folder globs because
 * no-restricted-imports matches the specifier string, not the resolved module.
 * Without them a layer could reach anything through ../index.js and the rule
 * would never fire.
 */
const entrypoints = ["**/index.js", "**/server.js", "**/cli.js"];

/**
 * Guard: the SqlText minter ban is folded into every non-dialect layer's rule
 * because a later override replaces no-restricted-imports outright instead of
 * merging with it; a layer override without it would silently lift the ban
 * for its files.
 */
const restrict = (
  message: string,
  {
    paths = [],
    folders = [],
    minters = true,
  }: { paths?: string[]; folders?: string[]; minters?: boolean },
) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...(minters ? [sqlMinters] : []),
        ...paths.map((name) => ({ name, message })),
      ],
      patterns: [{ group: [...folders, ...entrypoints], message }],
    },
  ],
});

const envMessage =
  "Configuration is read once in cli.ts and passed to a pure parser.";

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludeFiles: ["src/dialect/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { paths: [sqlMinters] }],
      },
    },
    {
      files: ["src/platform/**/*.ts"],
      rules: restrict(platformMessage, {
        paths: [...driverPackages, ...serverPackages],
        folders: ["**/dialect/**", "**/driver/**"],
      }),
    },
    {
      files: ["src/dialect/**/*.ts"],
      rules: restrict(dialectMessage, {
        paths: [...driverPackages, ...serverPackages],
        folders: ["**/driver/**"],
        minters: false,
      }),
    },
    {
      files: ["src/driver/**/*.ts"],
      rules: restrict(driverMessage, { paths: serverPackages }),
    },
    {
      files: ["src/**/*.ts"],
      excludeFiles: ["src/cli.ts"],
      rules: restrictProperties(
        ...casingProperties,
        processEnvProperty(envMessage),
      ),
    },
    {
      files: ["src/cli.ts"],
      rules: restrictProperties(...casingProperties),
    },
  ],
});
