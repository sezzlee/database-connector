export interface SealedCredential {
  readonly v: 1;
  readonly kid: string;
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
}

export interface CredentialKeyPair {
  readonly publicKey: string;
  readonly privateKey: JsonWebKey;
  readonly keyId: string;
}

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
const LABEL = "sezzlee.db-credential.v1";
const BLOCK = 256;

export class CredentialRejectedError extends Error {
  constructor() {
    super("credential_rejected");
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new CredentialRejectedError();
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Guard: JSON ignores trailing whitespace, so padding with spaces to a fixed
 * block hides the password length from everyone who stores the envelope.
 */
function pad(password: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(JSON.stringify({ v: 1, p: password }));
  const out = new Uint8Array(Math.ceil((body.length + 1) / BLOCK) * BLOCK).fill(
    0x20,
  );
  out.set(body);
  return out;
}

function unpad(bytes: ArrayBuffer): string {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== 1 ||
    !("p" in value) ||
    typeof value.p !== "string"
  )
    throw new CredentialRejectedError();
  return value.p;
}

async function importPublic(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new CredentialRejectedError();
  return crypto.subtle.importKey("raw", raw, CURVE, true, []);
}

async function contentKey(
  privateKey: CryptoKey,
  peer: CryptoKey,
  recipientRaw: Uint8Array,
  ephemeralRaw: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    privateKey,
    256,
  );
  const secret = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: concat(new TextEncoder().encode(LABEL), recipientRaw, ephemeralRaw),
    },
    secret,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function credentialKeyId(publicKey: string): Promise<string> {
  const raw = decode(publicKey);
  await importPublic(raw);
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
}

export function credentialPublicKeyOf(privateKey: JsonWebKey): string {
  if (
    privateKey.kty !== "EC" ||
    privateKey.crv !== "P-256" ||
    privateKey.x === undefined ||
    privateKey.y === undefined
  )
    throw new CredentialRejectedError();
  return encode(
    concat(Uint8Array.of(0x04), decode(privateKey.x), decode(privateKey.y)),
  );
}

export async function generateCredentialKeyPair(): Promise<CredentialKeyPair> {
  const pair = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
  const publicKey = encode(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  return {
    publicKey,
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    keyId: await credentialKeyId(publicKey),
  };
}

export async function sealCredential(
  recipientPublicKey: string,
  password: string,
  aad: string,
): Promise<SealedCredential> {
  const recipientRaw = decode(recipientPublicKey);
  const recipient = await importPublic(recipientRaw);
  const ephemeral = await crypto.subtle.generateKey(CURVE, false, [
    "deriveBits",
  ]);
  const ephemeralRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );
  const key = await contentKey(
    ephemeral.privateKey,
    recipient,
    recipientRaw,
    ephemeralRaw,
    "encrypt",
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    pad(password),
  );
  return {
    v: 1,
    kid: await credentialKeyId(recipientPublicKey),
    epk: encode(ephemeralRaw),
    iv: encode(iv),
    ct: encode(new Uint8Array(ct)),
  };
}

export async function openCredential(
  privateKey: JsonWebKey,
  envelope: SealedCredential,
  aad: string,
): Promise<string> {
  try {
    const recipientRaw = decode(credentialPublicKeyOf(privateKey));
    const recipient = await crypto.subtle.importKey(
      "jwk",
      privateKey,
      CURVE,
      false,
      ["deriveBits"],
    );
    const ephemeralRaw = decode(envelope.epk);
    const key = await contentKey(
      recipient,
      await importPublic(ephemeralRaw),
      recipientRaw,
      ephemeralRaw,
      "decrypt",
    );
    const iv = decode(envelope.iv);
    if (iv.length !== 12) throw new CredentialRejectedError();
    return unpad(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        key,
        decode(envelope.ct),
      ),
    );
  } catch {
    throw new CredentialRejectedError();
  }
}

export async function credentialKeyring(
  privateKeys: readonly JsonWebKey[],
): Promise<ReadonlyMap<string, JsonWebKey>> {
  const entries = await Promise.all(
    privateKeys.map(
      async (key) =>
        [await credentialKeyId(credentialPublicKeyOf(key)), key] as const,
    ),
  );
  return new Map(entries);
}
