import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { windowsServiceAccount } from "./home.ts";
import {
  POWERSHELL,
  readOwnerOnlyFile,
  writeOwnerOnlyFile,
} from "./owner-only-file.ts";

const SERVICE = "sezzlee-database-connector";
const KEY_BYTES = 32;
const SECRET_TOOL = "/usr/bin/secret-tool";

export const secretStoreSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("keychain"), account: z.uuid() }),
  z.strictObject({ kind: z.literal("secret-service"), account: z.uuid() }),
  z.strictObject({
    kind: z.literal("dpapi"),
    scope: z.enum(["user", "machine"]),
  }),
  z.strictObject({ kind: z.literal("file") }),
]);
export type SecretStore = z.infer<typeof secretStoreSchema>;
export type SecretStoreKind = SecretStore["kind"];
export type SecretStorePreference = "auto" | "file";

function tool(
  command: string,
  args: readonly string[],
  input = "",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 15000,
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 65536) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin.end(input);
  });
}

const dpapi = (
  method: "Protect" | "Unprotect",
  scope: "user" | "machine",
  input: string,
) =>
  tool(
    POWERSHELL,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${method}($b,$null,[System.Security.Cryptography.DataProtectionScope]::${scope === "machine" ? "LocalMachine" : "CurrentUser"}))`,
    ],
    input,
  );

function stateKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length !== KEY_BYTES)
    throw new Error("Connector state key is invalid");
  return key;
}

const keyFile = (statePath: string) => `${statePath}.key`;
const KEY_FILE = { label: "state key", maxBytes: 4096 } as const;

export async function readStateKey(
  store: SecretStore,
  statePath: string,
): Promise<Buffer> {
  switch (store.kind) {
    case "keychain":
      return stateKey(
        await tool("/usr/bin/security", [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          store.account,
          "-w",
        ]),
      );
    case "secret-service":
      return stateKey(
        await tool(SECRET_TOOL, [
          "lookup",
          "service",
          SERVICE,
          "account",
          store.account,
        ]),
      );
    case "dpapi":
      return stateKey(
        Buffer.from(
          await dpapi(
            "Unprotect",
            store.scope,
            await readOwnerOnlyFile(keyFile(statePath), KEY_FILE),
          ),
          "base64",
        ).toString("base64url"),
      );
    case "file":
      return stateKey(await readOwnerOnlyFile(keyFile(statePath), KEY_FILE));
  }
}

async function storeKey(
  store: SecretStore,
  statePath: string,
  key: Buffer,
): Promise<void> {
  const text = key.toString("base64url");
  switch (store.kind) {
    case "keychain":
      /*
       * Guard: `security -i` takes the command on stdin, so the key never
       * appears in an argument list another process could read. It reports
       * success either way, which is why every store is read back below.
       */
      await tool(
        "/usr/bin/security",
        ["-i"],
        `add-generic-password -U -s ${SERVICE} -a ${store.account} -w ${text}\n`,
      );
      break;
    case "secret-service":
      await tool(
        SECRET_TOOL,
        [
          "store",
          `--label=${SERVICE}`,
          "service",
          SERVICE,
          "account",
          store.account,
        ],
        text,
      );
      break;
    case "dpapi":
      await writeOwnerOnlyFile(
        keyFile(statePath),
        await dpapi("Protect", store.scope, key.toString("base64")),
      );
      break;
    case "file":
      await writeOwnerOnlyFile(keyFile(statePath), text);
  }
  if (!(await readStateKey(store, statePath)).equals(key))
    throw new Error("Connector state key was not stored");
}

function platformStore(): SecretStore {
  switch (process.platform) {
    case "darwin":
      return { kind: "keychain", account: randomUUID() };
    case "win32":
      return {
        kind: "dpapi",
        scope: windowsServiceAccount() === undefined ? "user" : "machine",
      };
    default:
      return { kind: "secret-service", account: randomUUID() };
  }
}

/**
 * Guard: only a Linux host without a working Secret Service falls back to a
 * key file. A failing Keychain or DPAPI stops the connector instead of
 * downgrading it silently.
 */
export async function createStateKey(
  statePath: string,
  preference: SecretStorePreference,
): Promise<{ readonly store: SecretStore; readonly key: Buffer }> {
  const key = randomBytes(KEY_BYTES);
  const preferred: SecretStore =
    preference === "file" ? { kind: "file" } : platformStore();
  try {
    await storeKey(preferred, statePath, key);
    return { store: preferred, key };
  } catch (error) {
    if (preferred.kind !== "secret-service") throw error;
  }
  const file: SecretStore = { kind: "file" };
  await storeKey(file, statePath, key);
  return { store: file, key };
}
