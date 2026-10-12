import { z } from "zod";

import { workspaceIdSchema } from "../workspace/workspace.ts";
import {
  databaseCredentialKeyIdSchema,
  databaseCredentialPublicKeySchema,
} from "./credential.ts";
import {
  databaseConnectorIdSchema,
  databaseDisplayNameSchema,
} from "./database.ts";

export const databaseConnectorStatusSchema = z.enum([
  "pending",
  "active",
  "revoked",
]);
export type DatabaseConnectorStatus = z.infer<
  typeof databaseConnectorStatusSchema
>;
export const createDatabaseConnectorSchema = z.strictObject({
  displayName: databaseDisplayNameSchema,
});
export type CreateDatabaseConnector = z.infer<
  typeof createDatabaseConnectorSchema
>;
export const databaseConnectorSummarySchema = z.strictObject({
  id: databaseConnectorIdSchema,
  displayName: databaseDisplayNameSchema,
  deviceId: z.string().nullable(),
  status: databaseConnectorStatusSchema,
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  credentialPublicKey: databaseCredentialPublicKeySchema.nullable(),
  credentialKeyId: databaseCredentialKeyIdSchema.nullable(),
});
export type DatabaseConnectorSummary = z.infer<
  typeof databaseConnectorSummarySchema
>;
export const databaseConnectorListResponseSchema = z.strictObject({
  connectors: z.array(databaseConnectorSummarySchema),
});
export type DatabaseConnectorListResponse = z.infer<
  typeof databaseConnectorListResponseSchema
>;
export const databaseConnectorPairingResponseSchema = z.strictObject({
  connector: databaseConnectorSummarySchema,
  pairingCode: z.string().min(16).max(256),
  pairingExpiresAt: z.iso.datetime(),
});
export type DatabaseConnectorPairingResponse = z.infer<
  typeof databaseConnectorPairingResponseSchema
>;
export const pairDatabaseConnectorSchema = z.strictObject({
  pairingCode: z.string().min(16).max(256),
  deviceId: z.string().trim().min(1).max(200),
  credentialPublicKey: databaseCredentialPublicKeySchema,
});
export type PairDatabaseConnector = z.infer<typeof pairDatabaseConnectorSchema>;
export const pairDatabaseConnectorResponseSchema = z.strictObject({
  token: z.string().min(43).max(256),
  connectorId: databaseConnectorIdSchema,
  workspaceId: workspaceIdSchema,
  credentialKeyId: databaseCredentialKeyIdSchema,
});
export type PairDatabaseConnectorResponse = z.infer<
  typeof pairDatabaseConnectorResponseSchema
>;

export const databaseConnectorMoveResponseSchema = z.strictObject({
  moveCode: z.string().min(16).max(256),
  moveExpiresAt: z.iso.datetime(),
});
export type DatabaseConnectorMoveResponse = z.infer<
  typeof databaseConnectorMoveResponseSchema
>;
export const moveDatabaseConnectorSchema = z.strictObject({
  moveCode: z.string().min(16).max(256),
  deviceId: z.string().trim().min(1).max(200),
  credentialPublicKey: databaseCredentialPublicKeySchema,
  proof: z.base64url().length(86),
});
export type MoveDatabaseConnector = z.infer<typeof moveDatabaseConnectorSchema>;

/**
 * Guard: the connector's public key is no secret, so a move is granted only to
 * a device that signs this message (ECDSA P-256, SHA-256, IEEE P1363) with the
 * connector's private key. Binding the move code and the new device id keeps a
 * captured proof from serving another move.
 */
export function databaseConnectorMoveProofMessage(
  moveCode: string,
  deviceId: string,
): string {
  return JSON.stringify([
    "sezzlee.database-connector.move",
    1,
    moveCode,
    deviceId,
  ]);
}

/** How many days a connector's bearer token lives before it must have been rotated. */
export const databaseConnectorTokenTtlDays = {
  min: 1,
  max: 365,
  default: 30,
} as const;

export const databaseExecutorTokenRequestSchema = z.strictObject({});
export type DatabaseExecutorTokenRequest = z.infer<
  typeof databaseExecutorTokenRequestSchema
>;

export const databaseExecutorTokenResponseSchema = z.discriminatedUnion(
  "rotated",
  [
    z.strictObject({ rotated: z.literal(false), expiresAt: z.iso.datetime() }),
    z.strictObject({
      rotated: z.literal(true),
      token: z.string().min(43).max(256),
      expiresAt: z.iso.datetime(),
    }),
  ],
);
export type DatabaseExecutorTokenResponse = z.infer<
  typeof databaseExecutorTokenResponseSchema
>;

const CONFIRMATION_LENGTH = 12;

/**
 * Guard: the part of a connector's key fingerprint a person compares between
 * the connector's terminal and the browser. Twelve base64url characters are 72
 * bits, beyond what an attacker can grind a matching key for; eight would not be.
 */
export function databaseConnectorConfirmationCode(keyId: string): string {
  return keyId.slice(0, CONFIRMATION_LENGTH).replace(/(.{4})(?=.)/gu, "$1 ");
}

export function databaseConnectorConfirmationMatches(
  keyId: string,
  typed: string,
): boolean {
  return (
    keyId.length >= CONFIRMATION_LENGTH &&
    typed.replace(/\s+/gu, "") === keyId.slice(0, CONFIRMATION_LENGTH)
  );
}

/** Connector keys this browser has verified, by connector id. */
export const databaseConnectorKeyPinsSchema = z.record(
  databaseConnectorIdSchema,
  databaseCredentialKeyIdSchema,
);
export type DatabaseConnectorKeyPins = z.infer<
  typeof databaseConnectorKeyPinsSchema
>;
