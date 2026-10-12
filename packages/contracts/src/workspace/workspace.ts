import { z } from "zod";

/**
 * Guard: the header only selects a context. The api re-derives the caller's
 * role from the database on every request, so a forged or stale value can at
 * most name a workspace the caller is then refused.
 */
export const WORKSPACE_HEADER = "x-workspace-id";

export const workspaceIdSchema = z.uuid();
export const workspaceKindSchema = z.enum(["self", "team"]);
export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * Team integrations, their tool policy and database sources are administered
 * by the owner and admins alike; membership, roles and deletion stay the
 * owner's.
 */
export function canManageIntegrations(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return workspaceIdSchema.safeParse(value).success;
}

export const workspaceParamsSchema = z.object({
  workspaceId: workspaceIdSchema,
});

export type WorkspaceParams = z.infer<typeof workspaceParamsSchema>;

export const teamNameSchema = z.string().trim().min(1).max(120);

export const createTeamSchema = z.object({ name: teamNameSchema });
export const renameTeamSchema = createTeamSchema;

export type CreateTeam = z.infer<typeof createTeamSchema>;
export type RenameTeam = z.infer<typeof renameTeamSchema>;

/**
 * `name` is null for a Self workspace: the client renders its localized label
 * instead of a stored string that would neither translate nor follow a rename.
 */
export const workspaceSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    id: workspaceIdSchema,
    kind: z.literal("self"),
    name: z.null(),
    role: z.literal("owner"),
  }),
  z.object({
    id: workspaceIdSchema,
    kind: z.literal("team"),
    name: z.string(),
    role: workspaceRoleSchema,
  }),
]);

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceListResponseSchema = z.array(workspaceSummarySchema);

export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const deletedTeamSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string(),
  deletedAt: z.iso.datetime(),
  restoreUntil: z.iso.datetime(),
});

export type DeletedTeamSummary = z.infer<typeof deletedTeamSummarySchema>;

export const deletedTeamListResponseSchema = z.array(deletedTeamSummarySchema);

export type DeletedTeamListResponse = z.infer<
  typeof deletedTeamListResponseSchema
>;
