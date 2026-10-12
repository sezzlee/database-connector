import { config } from "@sezzlee/oxlint-config/base";
import { outboundOnly } from "@chat/oxlint-config/chat";
import { defineConfig } from "oxlint";
export default defineConfig({
  extends: [config],
  ignorePatterns: ["dist"],
  overrides: outboundOnly,
});
