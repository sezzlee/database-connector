import { z } from "zod";

export const integrationIdSchema = z.uuid();

export type IntegrationId = z.infer<typeof integrationIdSchema>;

export const integrationOriginSchema = z.enum(["partner", "user", "team"]);

export type IntegrationOrigin = z.infer<typeof integrationOriginSchema>;

/**
 * Guard: whether a server asks for a token is a stored fact, not one derived
 * from whether credentials happen to be present. A registration that failed
 * halfway also has none, and reading that as "needs no token" would send this
 * platform at a guarded server with nothing to present.
 */
export const integrationAuthModeSchema = z.enum(["oauth", "none", "database"]);

export type IntegrationAuthMode = z.infer<typeof integrationAuthModeSchema>;

export const integrationKindSchema = z.enum([
  "remote_mcp",
  "database",
  "hosted_mcp",
]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;
