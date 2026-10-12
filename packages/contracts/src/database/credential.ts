import { z } from "zod";

import type { DatabaseTransport } from "./database.ts";

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u);

export const databaseCredentialPublicKeySchema = base64url(87, 87);
export const databaseCredentialKeyIdSchema = base64url(43, 43);
export const sealedDatabaseCredentialSchema = z.strictObject({
  v: z.literal(1),
  kid: databaseCredentialKeyIdSchema,
  epk: base64url(87, 87),
  iv: base64url(16, 16),
  ct: base64url(363, 40000),
});
export type SealedDatabaseCredential = z.infer<
  typeof sealedDatabaseCredentialSchema
>;
export const databaseCredentialPrivateKeySchema = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64url(43, 43),
  y: base64url(43, 43),
  d: base64url(43, 43),
});
export type DatabaseCredentialPrivateKey = z.infer<
  typeof databaseCredentialPrivateKeySchema
>;
export const databaseCredentialPrivateKeysSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "invalid_json" });
      return z.NEVER;
    }
  })
  .pipe(z.array(databaseCredentialPrivateKeySchema).min(1).max(8));

export interface DatabaseCredentialTarget {
  readonly workspaceId: string;
  readonly executor: string;
  readonly server: string;
  readonly port: number;
  readonly username: string;
  readonly transport: DatabaseTransport;
}

/**
 * Guard: the sealed password only opens for the target it was typed for. The
 * executor rebuilds this from the job it is about to run and fills `executor`
 * (and, on a connector, `workspaceId`) from its own state, so a server that
 * rewrites the host, port, SQL login, TLS settings, trusted certificate
 * authority or device of a stored connection gets a ciphertext that no longer
 * decrypts instead of the password. Version 2 added the login; a version 1
 * envelope no longer opens and its connection asks for the password again.
 */
export function databaseCredentialAad({
  workspaceId,
  executor,
  server,
  port,
  username,
  transport,
}: DatabaseCredentialTarget): string {
  const authority =
    transport.provider === "postgresql"
      ? transport.caCertificate?.trim()
      : undefined;
  return JSON.stringify([
    "sezzlee.db-credential",
    2,
    workspaceId,
    executor,
    transport.provider,
    server.trim(),
    port,
    username,
    ...(transport.provider === "mssql"
      ? [transport.encrypt, transport.trustServerCertificate]
      : [transport.sslMode]),
    ...(authority ? [authority] : []),
  ]);
}
