import type { OxlintOverride } from "oxlint";

type RestrictedProperty =
  | { object: string; property: string; message: string }
  | { property: string; message: string };

const casingMessage =
  "Use fold, canonical, asciiLower or asciiUpper from @sezzlee/file-core instead of locale-dependent casing.";

export const casingProperties: RestrictedProperty[] = [
  { property: "toLowerCase", message: casingMessage },
  { property: "toUpperCase", message: casingMessage },
];

export const processEnvProperty = (message: string): RestrictedProperty => ({
  object: "process",
  property: "env",
  message,
});

/**
 * Guard: every no-restricted-properties entry a file needs goes through one
 * call, because a later override replaces the rule's options outright instead
 * of merging them; a package that bans `process.env` next to the casing ban
 * must fold both lists into the same override or one silently stops applying.
 */
export const restrictProperties = (...entries: RestrictedProperty[]) =>
  ({ "no-restricted-properties": ["error", ...entries] }) as const;

export const casing: OxlintOverride[] = [
  {
    files: ["src/**/*.ts"],
    excludeFiles: ["src/unicode.ts"],
    rules: restrictProperties(...casingProperties),
  },
];
