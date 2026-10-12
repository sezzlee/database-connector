import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { databaseCredentialPrivateKeySchema } from "@chat/contracts/database/credential";
import { connectorHome } from "./home.ts";
import { readOwnerOnlyFile, writeOwnerOnlyFile } from "./owner-only-file.ts";
import {
  createStateKey,
  readStateKey,
  secretStoreSchema,
  type SecretStore,
  type SecretStoreKind,
  type SecretStorePreference,
} from "./secret-store.ts";

const deviceStateSchema = z.strictObject({
  apiUrl: z.url(),
  deviceId: z.uuid(),
  connectorId: z.uuid(),
  workspaceId: z.uuid(),
  token: z.string().min(43).max(256),
  credentialPrivateKey: databaseCredentialPrivateKeySchema,
});
export type DeviceState = z.infer<typeof deviceStateSchema>;

const plaintextStateSchema = deviceStateSchema.extend({
  version: z.literal(2),
});
const sealedStateSchema = z.strictObject({
  version: z.literal(3),
  store: secretStoreSchema,
  sealed: z.string().min(1).max(8192),
});

export interface DeviceStateLocation {
  readonly path?: string;
  readonly preference?: SecretStorePreference;
}

export function deviceStatePath(): string {
  return join(connectorHome(), "database-connector.json");
}

const STATE_FILE = { label: "state", maxBytes: 8192 } as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const ADDITIONAL_DATA = Buffer.from("sezzlee.database-connector.state.3");

function seal(state: DeviceState, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ADDITIONAL_DATA);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(deviceStateSchema.parse(state)), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

function open(sealed: string, key: Buffer): DeviceState {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES)
    throw new Error("Connector state is damaged");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(0, IV_BYTES),
  );
  decipher.setAAD(ADDITIONAL_DATA);
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  const text = Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
  return deviceStateSchema.parse(JSON.parse(text));
}

async function sealInto(
  path: string,
  state: DeviceState,
  store: SecretStore,
  key: Buffer,
): Promise<SecretStoreKind> {
  await writeOwnerOnlyFile(
    path,
    JSON.stringify({ version: 3, store, sealed: seal(state, key) }),
  );
  return store.kind;
}

export async function createDeviceState(
  state: DeviceState,
  location: DeviceStateLocation = {},
): Promise<SecretStoreKind> {
  const path = location.path ?? deviceStatePath();
  const { store, key } = await createStateKey(
    path,
    location.preference ?? "auto",
  );
  return sealInto(path, state, store, key);
}

/**
 * Guard: a rewrite keeps the store the state was sealed in. A key that cannot
 * be read is an error, never a reason to mint a new key, or a Secret Service
 * outage would quietly move the state into a key file.
 */
export async function writeDeviceState(
  state: DeviceState,
  location: DeviceStateLocation = {},
): Promise<SecretStoreKind> {
  const path = location.path ?? deviceStatePath();
  const { store } = sealedStateSchema.parse(
    JSON.parse(await readOwnerOnlyFile(path, STATE_FILE)),
  );
  return sealInto(path, state, store, await readStateKey(store, path));
}

export async function readDeviceState(
  location: DeviceStateLocation = {},
): Promise<{ readonly state: DeviceState; readonly store: SecretStoreKind }> {
  const path = location.path ?? deviceStatePath();
  const value: unknown = JSON.parse(await readOwnerOnlyFile(path, STATE_FILE));
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1
  )
    throw new Error("Connector state predates credential keys; pair again");
  const plaintext = plaintextStateSchema.safeParse(value);
  if (plaintext.success) {
    const { version: _, ...state } = plaintext.data;
    return { state, store: await createDeviceState(state, location) };
  }
  const file = sealedStateSchema.parse(value);
  return {
    state: open(file.sealed, await readStateKey(file.store, path)),
    store: file.store.kind,
  };
}
