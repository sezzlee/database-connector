import type { OxlintConfig } from "oxlint";
import { config as base } from "@sezzlee/oxlint-config/base";

export const config = {
  ...base,
  plugins: [...base.plugins, "react"],
  rules: {
    ...base.rules,
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "warn",
    "react/static-components": "error",
    "react/use-memo": "error",
    "react/preserve-manual-memoization": "error",
    "react/incompatible-library": "warn",
    "react/immutability": "error",
    "react/globals": "error",
    "react/refs": "error",
    "react/set-state-in-effect": "error",
    "react/error-boundaries": "error",
    "react/purity": "error",
    "react/set-state-in-render": "error",
    "react/unsupported-syntax": "warn",
  },
  overrides: [
    ...base.overrides,
    { files: ["**/*"], env: { browser: true, serviceworker: true } },
  ],
} satisfies OxlintConfig;
