import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { casing } from "@sezzlee/oxlint-config/casing";

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: [...casing],
});
