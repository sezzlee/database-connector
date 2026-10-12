import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import {
  casingProperties,
  processEnvProperty,
  restrictProperties,
} from "@sezzlee/oxlint-config/casing";

const minters = {
  name: "@sezzlee/db-core",
  importNames: ["sqlText", "quotedIdentifier"],
  message: "SQL and identifiers are minted only inside the dialect.",
};
const entrypoints = ["**/index.js", "**/server.js", "**/cli.js"];
const restrict = (paths: string[], folders: string[], sql = true) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [
        ...(sql ? [minters] : []),
        ...paths.map((name) => ({
          name,
          message: "Respect platform, dialect and driver boundaries.",
        })),
      ],
      patterns: [
        {
          group: [...folders, ...entrypoints],
          message: "Respect platform, dialect and driver boundaries.",
        },
      ],
    },
  ],
});

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludeFiles: ["src/dialect/**/*.ts"],
      rules: { "no-restricted-imports": ["error", { paths: [minters] }] },
    },
    {
      files: ["src/platform/**/*.ts"],
      rules: restrict(
        ["pg", "pg-cursor", "@modelcontextprotocol/server"],
        ["**/dialect/**", "**/driver/**"],
      ),
    },
    {
      files: ["src/dialect/**/*.ts"],
      rules: restrict(
        ["pg", "pg-cursor", "@modelcontextprotocol/server"],
        ["**/driver/**"],
        false,
      ),
    },
    {
      files: ["src/driver/**/*.ts"],
      rules: restrict(["@modelcontextprotocol/server"], []),
    },
    {
      files: ["src/**/*.ts"],
      excludeFiles: ["src/cli.ts"],
      rules: restrictProperties(
        ...casingProperties,
        processEnvProperty("Environment is read only in cli.ts."),
      ),
    },
    { files: ["src/cli.ts"], rules: restrictProperties(...casingProperties) },
  ],
});
