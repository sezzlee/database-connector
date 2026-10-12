import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseAllowedTargetSchema } from "@chat/contracts/database/allowlist";
import {
  allowTarget,
  disallowTarget,
  readAllowlist,
} from "../src/allowlist.ts";

const target = (text: string) => databaseAllowedTargetSchema.parse(text);

describe("connector allowlist file", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "connector-allowlist-"));
    file = join(dir, ".sezzlee", "database-connector-allow.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a missing file as an empty allowlist", async () => {
    expect(await readAllowlist(file)).toEqual([]);
  });

  it("keeps added targets in an owner-only file, once each, until they are removed", async () => {
    expect(await allowTarget(target("sql01.corp.local:1433"), file)).toBe(true);
    expect(await allowTarget(target("SQL01.corp.local:1433"), file)).toBe(
      false,
    );
    expect(await allowTarget(target("[fd00::5]:5432"), file)).toBe(true);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      targets: ["sql01.corp.local:1433", "[fd00::5]:5432"],
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, ".sezzlee"))).mode & 0o777).toBe(0o700);
    }

    expect(await disallowTarget(target("sql01.corp.local:1433"), file)).toBe(
      true,
    );
    expect(await disallowTarget(target("sql01.corp.local:1433"), file)).toBe(
      false,
    );
    expect(await readAllowlist(file)).toEqual([
      { host: "fd00::5", port: 5432 },
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a file other users can read",
    async () => {
      await allowTarget(target("sql01:1433"), file);
      await chmod(file, 0o644);
      await expect(readAllowlist(file)).rejects.toThrow(
        "Connector allowlist requires owner-only permissions",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a file whose directory other users can open",
    async () => {
      await allowTarget(target("sql01:1433"), file);
      await chmod(join(dir, ".sezzlee"), 0o755);
      await expect(readAllowlist(file)).rejects.toThrow(
        "Connector allowlist directory requires owner-only permissions",
      );
    },
  );

  it("refuses a symlink in place of the file", async () => {
    const real = join(dir, "elsewhere.json");
    await allowTarget(target("sql01:1433"), real);
    await allowTarget(target("sql02:1433"), file);
    await rm(file);
    await symlink(real, file);
    await expect(readAllowlist(file)).rejects.toThrow(
      "Unsafe connector allowlist file",
    );
  });

  it("refuses a file larger than 64 KB before reading it", async () => {
    await allowTarget(target("sql01:1433"), file);
    await writeFile(file, " ".repeat(65537));
    if (process.platform !== "win32") await chmod(file, 0o600);
    await expect(readAllowlist(file)).rejects.toThrow(
      "Unsafe connector allowlist file",
    );
  });

  it("refuses a hand-edited file that names something other than host:port", async () => {
    await allowTarget(target("sql01:1433"), file);
    await writeFile(
      file,
      JSON.stringify({ version: 1, targets: ["sql01:1433", "*:1433"] }),
    );
    if (process.platform !== "win32") await chmod(file, 0o600);
    await expect(readAllowlist(file)).rejects.toThrow("invalid_target");
  });
});
