import { dbCoreLimits } from "@sezzlee/db-core";

export const limits = {
  ...dbCoreLimits,
  queryTimeoutMs: 30000,
  maxConnections: 4,
} as const;
