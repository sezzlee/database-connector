import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SERVICE_HOME,
  SERVICE_USER,
  launchAgent,
  systemdUnit,
} from "../src/service.ts";

function directives(unit: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of unit.split("\n")) {
    const match = /^([A-Za-z]+)=(.*)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]]);
  }
  return found;
}

describe("connector service definitions", () => {
  it("runs the systemd service as its own user, unable to gain privileges or write outside its state", () => {
    const unit = directives(systemdUnit());

    expect(unit.get("User")).toEqual([SERVICE_USER]);
    expect(unit.get("Group")).toEqual([SERVICE_USER]);
    expect(unit.get("NoNewPrivileges")).toEqual(["yes"]);
    expect(unit.get("CapabilityBoundingSet")).toEqual([""]);
    expect(unit.get("AmbientCapabilities")).toEqual([""]);
    expect(unit.get("ProtectSystem")).toEqual(["strict"]);
    expect(unit.get("ReadWritePaths")).toEqual([SERVICE_HOME]);
    expect(unit.get("UMask")).toEqual(["0077"]);
    expect(unit.get("ExecStart")?.[0]).toMatch(/ run$/u);
  });

  it.runIf(process.platform === "darwin")(
    "writes a launch agent plist that macOS accepts, with paths that need escaping",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "connector-agent-"));
      const file = join(dir, "agent.plist");
      try {
        const executable =
          "/Applications/R&D <tools>/sezzlee-database-connector";
        await writeFile(file, launchAgent(executable, "/tmp/a&b.log"));

        execFileSync("/usr/bin/plutil", ["-lint", file]);
        const programArguments: unknown = JSON.parse(
          execFileSync(
            "/usr/bin/plutil",
            ["-extract", "ProgramArguments", "json", "-o", "-", file],
            { encoding: "utf8" },
          ),
        );
        expect(programArguments).toEqual([executable, "run"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
