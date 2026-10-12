import { execFileSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeviceState,
  readDeviceState,
  writeDeviceState,
  type DeviceState,
} from "../src/device-state.ts";

const state: DeviceState = {
  apiUrl: "https://api.example.com/api/",
  deviceId: "0199aabb-0000-7000-8000-000000000001",
  connectorId: "0199aabb-0000-7000-8000-000000000002",
  workspaceId: "0199aabb-0000-7000-8000-000000000003",
  token: "a".repeat(64),
  credentialPrivateKey: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
    d: "d".repeat(43),
  },
};

const ownerOnly = async (file: string) => {
  if (process.platform !== "win32") await chmod(file, 0o600);
};

describe("connector state storage", () => {
  let dir: string;
  let file: string;
  const onDisk = { preference: "file" } as const;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "database-device-"));
    file = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps neither the token nor the private key readable in the state file", async () => {
    await createDeviceState(state, { path: file, ...onDisk });

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(state.token);
    expect(raw).not.toContain(state.credentialPrivateKey.d);
    expect(await readDeviceState({ path: file })).toEqual({
      state,
      store: "file",
    });
  });

  it("stores state with owner-only permissions and refuses permissive files", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    if (process.platform === "win32") return;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(`${file}.key`)).mode & 0o777).toBe(0o600);
    await chmod(file, 0o644);
    await expect(readDeviceState({ path: file })).rejects.toThrow("owner-only");
  });

  it("refuses a state file whose sealed bytes were altered", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    const sealed = JSON.parse(await readFile(file, "utf8"));
    const bytes = Buffer.from(sealed.sealed, "base64url");
    const flipped = bytes.length - 20;
    bytes.writeUInt8(bytes.readUInt8(flipped) ^ 1, flipped);
    await writeFile(
      file,
      JSON.stringify({ ...sealed, sealed: bytes.toString("base64url") }),
    );
    await ownerOnly(file);

    await expect(readDeviceState({ path: file })).rejects.toThrow();
  });

  it("refuses a state file opened with another key", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    await writeFile(`${file}.key`, Buffer.alloc(32, 7).toString("base64url"));
    await ownerOnly(`${file}.key`);

    await expect(readDeviceState({ path: file })).rejects.toThrow();
  });

  it("seals a plaintext state file from before the secret store when it first reads it", async () => {
    await writeFile(file, JSON.stringify({ version: 2, ...state }));
    await ownerOnly(file);

    expect(await readDeviceState({ path: file, ...onDisk })).toEqual({
      state,
      store: "file",
    });
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(state.token);
    expect(raw).not.toContain(state.credentialPrivateKey.d);
    expect(await readDeviceState({ path: file })).toEqual({
      state,
      store: "file",
    });
  });

  it("rewrites state under the key it was sealed with", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    const key = await readFile(`${file}.key`, "utf8");
    const rotated = { ...state, token: "b".repeat(64) };

    expect(await writeDeviceState(rotated, { path: file })).toBe("file");

    expect(await readFile(`${file}.key`, "utf8")).toBe(key);
    expect(await readDeviceState({ path: file })).toEqual({
      state: rotated,
      store: "file",
    });
  });

  it("refuses to rewrite state whose key it cannot read rather than moving it to another store", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    const sealed = await readFile(file, "utf8");
    await rm(`${file}.key`);

    await expect(
      writeDeviceState({ ...state, token: "b".repeat(64) }, { path: file }),
    ).rejects.toThrow();

    expect(await readFile(file, "utf8")).toBe(sealed);
  });

  it("refuses state written before connectors held a credential key", async () => {
    const { credentialPrivateKey: _, ...legacy } = state;
    await writeFile(file, JSON.stringify({ ...legacy, version: 1 }));
    await ownerOnly(file);

    await expect(readDeviceState({ path: file })).rejects.toThrow("pair again");
  });

  it("refuses symlinks", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    await symlink(file, join(dir, "link.json"));

    await expect(
      readDeviceState({ path: join(dir, "link.json") }),
    ).rejects.toThrow("Unsafe");
  });

  it("refuses a state file larger than 8 KB before reading it", async () => {
    await createDeviceState(state, { path: file, ...onDisk });
    await writeFile(file, " ".repeat(8193));
    await ownerOnly(file);

    await expect(readDeviceState({ path: file })).rejects.toThrow(
      "Unsafe connector state file",
    );
  });

  it.runIf(process.platform === "linux")(
    "falls back to an owner-only key file when no Secret Service answers",
    async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
      vi.stubEnv("DISPLAY", "");
      try {
        expect(await createDeviceState(state, { path: file })).toBe("file");
      } finally {
        vi.unstubAllEnvs();
      }
      expect(await readDeviceState({ path: file })).toEqual({
        state,
        store: "file",
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps the state key in the macOS Keychain and nothing beside the state file",
    async () => {
      expect(await createDeviceState(state, { path: file })).toBe("keychain");
      const { store } = JSON.parse(await readFile(file, "utf8"));
      try {
        await expect(stat(`${file}.key`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readDeviceState({ path: file })).toEqual({
          state,
          store: "keychain",
        });
      } finally {
        execFileSync("/usr/bin/security", [
          "delete-generic-password",
          "-s",
          "sezzlee-database-connector",
          "-a",
          store.account,
        ]);
      }
      await expect(readDeviceState({ path: file })).rejects.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps the state key sealed by DPAPI",
    async () => {
      expect(await createDeviceState(state, { path: file })).toBe("dpapi");
      const key = await readFile(`${file}.key`, "utf8");
      expect(Buffer.from(key, "base64").length).toBeGreaterThan(32);
      expect(await readDeviceState({ path: file })).toEqual({
        state,
        store: "dpapi",
      });
    },
  );
});
