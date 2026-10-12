import { z } from "zod";

import { integrationIdSchema } from "../integration/integration.ts";
import { workspaceUserIdSchema } from "../workspace/member.ts";
import {
  databaseConnectionIdSchema,
  databaseDisplayNameSchema,
  databaseLimits,
  databaseMaxRowsSchema,
  databaseNativeNameSchema,
  databaseRedistributionModeSchema,
  databaseSourceAccessModeSchema,
  databaseSourceIdSchema,
  databaseStatusSchema,
} from "./database.ts";

/** `userIds` names who may use a restricted source; owners and admins always may. */
export const databaseSourceAccessSchema = z
  .strictObject({
    mode: databaseSourceAccessModeSchema,
    userIds: z.array(workspaceUserIdSchema).max(500).default([]),
  })
  .refine((input) => new Set(input.userIds).size === input.userIds.length, {
    error: "duplicate_user",
  });
export type DatabaseSourceAccess = z.infer<typeof databaseSourceAccessSchema>;

/**
 * Who content derived from the source may be shared with. Independent of
 * `access`: reading a shared result never requires query access.
 */
export const databaseRedistributionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("unrestricted") }),
  z.strictObject({ mode: z.literal("workspace_only") }),
  z.strictObject({
    mode: z.literal("named_members"),
    userIds: z
      .array(workspaceUserIdSchema)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, {
        error: "duplicate_user",
      }),
  }),
  z.strictObject({ mode: z.literal("blocked") }),
]);
export type DatabaseRedistribution = z.infer<
  typeof databaseRedistributionSchema
>;

export const databaseSourceInputSchema = z.strictObject({
  database: databaseNativeNameSchema,
  displayName: databaseDisplayNameSchema,
  description: z.string().trim().max(2000).optional(),
  maxRows: databaseMaxRowsSchema.default(databaseLimits.maxRows.default),
  selectedByDefault: z.boolean().default(false),
  access: databaseSourceAccessSchema.optional(),
  redistribution: databaseRedistributionSchema.optional(),
});
export type DatabaseSourceInput = z.infer<typeof databaseSourceInputSchema>;
export const createDatabaseSourceSchema = databaseSourceInputSchema.extend({
  connectionId: databaseConnectionIdSchema,
});
export type CreateDatabaseSource = z.infer<typeof createDatabaseSourceSchema>;
export type CreateDatabaseSourceRequest = z.input<
  typeof createDatabaseSourceSchema
>;
export const databaseSourceSummarySchema = z.strictObject({
  id: databaseSourceIdSchema,
  connectionId: databaseConnectionIdSchema,
  integrationId: integrationIdSchema,
  database: databaseNativeNameSchema,
  displayName: databaseDisplayNameSchema,
  description: z.string().nullable(),
  status: databaseStatusSchema,
  maxRows: databaseMaxRowsSchema,
  selectedByDefault: z.boolean(),
  accessMode: databaseSourceAccessModeSchema,
  accessUserIds: z.array(workspaceUserIdSchema).optional(),
  redistributionMode: databaseRedistributionModeSchema,
  redistributionUserIds: z.array(workspaceUserIdSchema).optional(),
});
export type DatabaseSourceSummary = z.infer<typeof databaseSourceSummarySchema>;
export const updateDatabaseSourceSchema = z
  .strictObject({
    displayName: databaseDisplayNameSchema.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: databaseStatusSchema.optional(),
    maxRows: databaseMaxRowsSchema.optional(),
    selectedByDefault: z.boolean().optional(),
    access: databaseSourceAccessSchema.optional(),
    redistribution: databaseRedistributionSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { error: "empty_update" });
export type UpdateDatabaseSource = z.infer<typeof updateDatabaseSourceSchema>;
export type UpdateDatabaseSourceRequest = z.input<
  typeof updateDatabaseSourceSchema
>;
export const databaseSourceListResponseSchema = z.strictObject({
  sources: z.array(databaseSourceSummarySchema),
});
export type DatabaseSourceListResponse = z.infer<
  typeof databaseSourceListResponseSchema
>;
export const databaseDiscoveryResponseSchema = z.strictObject({
  databases: z.array(databaseNativeNameSchema).max(10000),
});
export type DatabaseDiscoveryResponse = z.infer<
  typeof databaseDiscoveryResponseSchema
>;
