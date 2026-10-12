import { defineConfig } from "oxlint";
import { config } from "@sezzlee/oxlint-config/base";
import { outboundOnly } from "@chat/oxlint-config/chat";

export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist/**"],
  overrides: outboundOnly,
});
