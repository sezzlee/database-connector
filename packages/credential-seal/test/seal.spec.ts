import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialRejectedError,
  credentialPublicKeyOf,
  generateCredentialKeyPair,
  openCredential,
  sealCredential,
  type SealedCredential,
} from "../src/seal.ts";

const AAD = '["sezzlee.db-credential",1,"workspace","managed"]';
const LABEL = Buffer.from("sezzlee.db-credential.v1");
const b64 = (bytes: Buffer) => bytes.toString("base64url");
const raw = (text: string) => Buffer.from(text, "base64url");

function nodeKey(shared: Buffer, recipient: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.alloc(0),
      Buffer.concat([LABEL, recipient, ephemeral]),
      32,
    ),
  );
}

function nodeOpen(
  privateKey: JsonWebKey,
  envelope: SealedCredential,
  aad: string,
) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(raw(privateKey.d ?? ""));
  const ephemeral = raw(envelope.epk);
  const key = nodeKey(
    ecdh.computeSecret(ephemeral),
    ecdh.getPublicKey(),
    ephemeral,
  );
  const sealed = raw(envelope.ct);
  const decipher = createDecipheriv("aes-256-gcm", key, raw(envelope.iv));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, -16)),
    decipher.final(),
  ]);
  return { bytes: plain.length, value: JSON.parse(plain.toString("utf8")) };
}

function nodeSeal(
  publicKey: string,
  password: string,
  aad: string,
): SealedCredential {
  const ecdh = createECDH("prime256v1");
  const ephemeral = ecdh.generateKeys();
  const key = nodeKey(
    ecdh.computeSecret(raw(publicKey)),
    raw(publicKey),
    ephemeral,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.from(JSON.stringify({ v: 1, p: password }));
  const ct = Buffer.concat([
    cipher.update(body),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { v: 1, kid: "unused", epk: b64(ephemeral), iv: b64(iv), ct: b64(ct) };
}

function flip(text: string, index: number): string {
  const bytes = raw(text);
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return b64(bytes);
}

describe("credential seal", () => {
  it("is opened by an independent ECDH, HKDF and AES-GCM implementation", async () => {
    const pair = await generateCredentialKeyPair();
    const envelope = await sealCredential(pair.publicKey, "pa$$wörd", AAD);
    expect(nodeOpen(pair.privateKey, envelope, AAD).value).toEqual({
      v: 1,
      p: "pa$$wörd",
    });
  });

  it("opens an envelope sealed by an independent implementation", async () => {
    const pair = await generateCredentialKeyPair();
    await expect(
      openCredential(
        pair.privateKey,
        nodeSeal(pair.publicKey, "s3cret", AAD),
        AAD,
      ),
    ).resolves.toBe("s3cret");
  });

  it("derives the recipient public key and a SHA-256 key id from the key pair", async () => {
    const pair = await generateCredentialKeyPair();
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(raw(pair.privateKey.d ?? ""));
    expect(credentialPublicKeyOf(pair.privateKey)).toBe(
      b64(ecdh.getPublicKey()),
    );
    expect(pair.publicKey).toBe(b64(ecdh.getPublicKey()));
    expect(pair.keyId).toBe(
      b64(createHash("sha256").update(ecdh.getPublicKey()).digest()),
    );
  });

  it("pads every password under one block to the same ciphertext size", async () => {
    const pair = await generateCredentialKeyPair();
    const short = await sealCredential(pair.publicKey, "a", AAD);
    const long = await sealCredential(pair.publicKey, "a".repeat(200), AAD);
    expect(nodeOpen(pair.privateKey, short, AAD).bytes).toBe(256);
    expect(raw(short.ct).length).toBe(raw(long.ct).length);
  });

  it.each([
    ["epk", (e: SealedCredential) => ({ ...e, epk: flip(e.epk, 40) })],
    ["iv", (e: SealedCredential) => ({ ...e, iv: flip(e.iv, 0) })],
    ["ciphertext", (e: SealedCredential) => ({ ...e, ct: flip(e.ct, 0) })],
    [
      "tag",
      (e: SealedCredential) => ({ ...e, ct: flip(e.ct, raw(e.ct).length - 1) }),
    ],
    [
      "truncated iv",
      (e: SealedCredential) => ({ ...e, iv: b64(raw(e.iv).subarray(1)) }),
    ],
    [
      "off-curve epk",
      (e: SealedCredential) => ({
        ...e,
        epk: b64(Buffer.concat([Buffer.of(4), Buffer.alloc(64, 1)])),
      }),
    ],
  ])("rejects a tampered %s", async (_, tamper) => {
    const pair = await generateCredentialKeyPair();
    const envelope = await sealCredential(pair.publicKey, "secret", AAD);
    await expect(
      openCredential(pair.privateKey, tamper(envelope), AAD),
    ).rejects.toBeInstanceOf(CredentialRejectedError);
  });

  it("rejects a different AAD and a different recipient", async () => {
    const pair = await generateCredentialKeyPair();
    const other = await generateCredentialKeyPair();
    const envelope = await sealCredential(pair.publicKey, "secret", AAD);
    await expect(
      openCredential(
        pair.privateKey,
        envelope,
        AAD.replace("managed", "connector"),
      ),
    ).rejects.toBeInstanceOf(CredentialRejectedError);
    await expect(
      openCredential(other.privateKey, envelope, AAD),
    ).rejects.toBeInstanceOf(CredentialRejectedError);
  });
});
