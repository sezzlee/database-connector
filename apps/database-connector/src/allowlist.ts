import { join } from "node:path";
import {
  databaseAllowlistSchema,
  formatDatabaseAllowedTarget,
  type DatabaseAllowedTarget,
} from "@chat/contracts/database/allowlist";
import { connectorHome } from "./home.ts";
import { readOwnerOnlyFile, writeOwnerOnlyFile } from "./owner-only-file.ts";

export function allowlistPath(): string {
  return join(connectorHome(), "database-connector-allow.json");
}

/** A missing file is an empty allowlist, so a connector nobody configured dials nothing. */
export async function readAllowlist(
  path = allowlistPath(),
): Promise<readonly DatabaseAllowedTarget[]> {
  let text: string;
  try {
    text = await readOwnerOnlyFile(path, {
      label: "allowlist",
      maxBytes: 65536,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  return databaseAllowlistSchema.parse(JSON.parse(text)).targets;
}

async function writeAllowlist(
  targets: readonly DatabaseAllowedTarget[],
  path: string,
): Promise<void> {
  const file = {
    version: 1,
    targets: [...new Set(targets.map(formatDatabaseAllowedTarget))],
  };
  databaseAllowlistSchema.parse(file);
  await writeOwnerOnlyFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

export async function allowTarget(
  target: DatabaseAllowedTarget,
  path = allowlistPath(),
): Promise<boolean> {
  const targets = await readAllowlist(path);
  if (targets.some((entry) => sameTarget(entry, target))) return false;
  await writeAllowlist([...targets, target], path);
  return true;
}

export async function disallowTarget(
  target: DatabaseAllowedTarget,
  path = allowlistPath(),
): Promise<boolean> {
  const targets = await readAllowlist(path);
  const kept = targets.filter((entry) => !sameTarget(entry, target));
  if (kept.length === targets.length) return false;
  await writeAllowlist(kept, path);
  return true;
}

function sameTarget(
  a: DatabaseAllowedTarget,
  b: DatabaseAllowedTarget,
): boolean {
  return a.host === b.host && a.port === b.port;
}
