import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { databaseCredentialPrivateKeySchema } from "@chat/contracts/database/credential";

const INFO = "sezzlee.database-connector.move.1";
const CODE_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const moveBundleSchema = z.strictObject({
  apiUrl: z.url(),
  connectorId: z.uuid(),
  workspaceId: z.uuid(),
  credentialPrivateKey: databaseCredentialPrivateKeySchema,
  allowlist: z.array(z.string().max(300)).max(256),
});
export type MoveBundle = z.infer<typeof moveBundleSchema>;

const moveFileSchema = z.strictObject({
  kind: z.literal("sezzlee-database-connector-move"),
  version: z.literal(1),
  salt: z.base64url().length(22),
  sealed: z.base64url().max(16384),
});

function encodeCode(bytes: Buffer): string {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let text = "";
  for (let at = 0; at < bits.length; at += 5)
    text += BASE32[Number.parseInt(bits.slice(at, at + 5).padEnd(5, "0"), 2)];
  return text.replace(/(.{4})(?=.)/gu, "$1-");
}

function decodeCode(typed: string): Buffer | undefined {
  const text = typed.toUpperCase().replace(/[\s-]/gu, "");
  if (!/^[A-Z2-7]{26}$/u.test(text)) return undefined;
  let bits = "";
  for (const char of text)
    bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  if (/1/u.test(bits.slice(CODE_BYTES * 8))) return undefined;
  const bytes = Buffer.alloc(CODE_BYTES);
  for (let index = 0; index < CODE_BYTES; index++)
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  return bytes;
}

const keyFrom = (code: Buffer, salt: Buffer) =>
  Buffer.from(hkdfSync("sha256", code, salt, INFO, 32));

/**
 * Guard: the export code is 128 random bits shown once on the old machine and
 * typed on the new one, so a plain HKDF is enough; a password-style slow hash
 * would only matter for a code a person chose.
 */
export function sealMoveBundle(bundle: MoveBundle): {
  readonly file: string;
  readonly exportCode: string;
} {
  const code = randomBytes(CODE_BYTES);
  const salt = randomBytes(16);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(code, salt), iv);
  cipher.setAAD(Buffer.from(INFO));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(moveBundleSchema.parse(bundle)), "utf8"),
    cipher.final(),
  ]);
  return {
    file: JSON.stringify({
      kind: "sezzlee-database-connector-move",
      version: 1,
      salt: salt.toString("base64url"),
      sealed: Buffer.concat([iv, body, cipher.getAuthTag()]).toString(
        "base64url",
      ),
    }),
    exportCode: encodeCode(code),
  };
}

export function openMoveBundle(text: string, typedCode: string): MoveBundle {
  const file = moveFileSchema.parse(JSON.parse(text));
  const code = decodeCode(typedCode);
  if (code === undefined) throw new Error("Export code is not valid");
  const bytes = Buffer.from(file.sealed, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES)
    throw new Error("Move file is damaged");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFrom(code, Buffer.from(file.salt, "base64url")),
    bytes.subarray(0, IV_BYTES),
  );
  decipher.setAAD(Buffer.from(INFO));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]);
  return moveBundleSchema.parse(JSON.parse(plain.toString("utf8")));
}
