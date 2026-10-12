import { z } from "zod";

/**
 * Guard: a session id becomes a directory name under the upload root, and that
 * directory is the sandbox root handed to the MCP reader. Constraining it to a
 * UUID is what makes the path safe by construction — no separator, no `..`, no
 * absolute prefix can survive this parse, so no caller needs to sanitise it
 * again downstream.
 */
export const sessionIdSchema = z.uuid();

export type SessionId = z.infer<typeof sessionIdSchema>;

export function isSessionId(value: unknown): value is SessionId {
  return sessionIdSchema.safeParse(value).success;
}
