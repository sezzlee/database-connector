export const mcpCoreLimits = {
  maxPayloadBytes: 512 * 1024,
  maxStringChars: 512,
  catalogTtlMs: 5 * 60 * 1000,
} as const;

export type McpCoreLimits = typeof mcpCoreLimits;
