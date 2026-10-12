import { z } from "zod";

import { workspaceParamsSchema, workspaceRoleSchema } from "./workspace.ts";

export const memberRoleSchema = z.enum(["admin", "member"]);

export type MemberRole = z.infer<typeof memberRoleSchema>;

export const workspaceUserIdSchema = z.uuid();

export const memberParamsSchema = workspaceParamsSchema.extend({
  userId: workspaceUserIdSchema,
});

export type MemberParams = z.infer<typeof memberParamsSchema>;

export const changeMemberRoleSchema = z.object({ role: memberRoleSchema });

export type ChangeMemberRole = z.infer<typeof changeMemberRoleSchema>;

export const transferOwnershipSchema = z.object({
  userId: workspaceUserIdSchema,
});

export type TransferOwnership = z.infer<typeof transferOwnershipSchema>;

export const workspaceMemberSummarySchema = z.object({
  userId: workspaceUserIdSchema,
  name: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.iso.datetime().nullable(),
  disabled: z.boolean(),
});

export type WorkspaceMemberSummary = z.infer<
  typeof workspaceMemberSummarySchema
>;

export const memberListResponseSchema = z.array(workspaceMemberSummarySchema);

export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
