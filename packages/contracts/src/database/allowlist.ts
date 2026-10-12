import { z } from "zod";

import { bareHost, ipv6Groups } from "../common/network-address.ts";
import { databasePortSchema } from "./database.ts";

const HOSTNAME =
  /^(?=.{1,253}\.?$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/iu;
const TARGET =
  /^(?:\[(?<bracketed>[^\]]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/u;

/**
 * One `host:port` a connector may dial, typed by the customer on the connector's
 * machine. An IPv6 address is written in brackets (`[fd00::5]:1433`).
 */
export const databaseAllowedTargetSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const parts = TARGET.exec(value)?.groups;
    const host =
      parts?.bracketed !== undefined
        ? ipv6Groups(bareHost(parts.bracketed)) && parts.bracketed
        : parts?.host !== undefined && HOSTNAME.test(parts.host) && parts.host;
    const port = databasePortSchema.safeParse(Number(parts?.port));
    if (host === undefined || host === false || !port.success) {
      context.issues.push({
        code: "custom",
        message: "invalid_target",
        input: value,
      });
      return z.NEVER;
    }
    return { host: bareHost(host), port: port.data };
  })
  .brand<"DatabaseAllowedTarget">();
export type DatabaseAllowedTarget = z.infer<typeof databaseAllowedTargetSchema>;

export const databaseAllowlistLimit = 256;

/** The connector's local allowlist file. The api has no route that reads or writes it. */
export const databaseAllowlistSchema = z.strictObject({
  version: z.literal(1),
  targets: z.array(databaseAllowedTargetSchema).max(databaseAllowlistLimit),
});
export type DatabaseAllowlist = z.infer<typeof databaseAllowlistSchema>;

export function formatDatabaseAllowedTarget(target: {
  readonly host: string;
  readonly port: number;
}): string {
  const host = bareHost(target.host);
  return `${host.includes(":") ? `[${host}]` : host}:${target.port}`;
}

/**
 * Guard: the target as one shell argument that sh, zsh, PowerShell and cmd read
 * back unchanged. Only a parsed target is accepted, so no shell metacharacter can
 * reach it; brackets are quoted because zsh reads `[...]` as a glob.
 */
export function databaseAllowedTargetArgument(
  target: DatabaseAllowedTarget,
): string {
  const text = formatDatabaseAllowedTarget(target);
  return text.startsWith("[") ? `"${text}"` : text;
}

export function databaseTargetAllowed(
  allowed: readonly DatabaseAllowedTarget[],
  target: { readonly server: string; readonly port: number },
): boolean {
  const host = bareHost(target.server);
  return allowed.some(
    (entry) => entry.host === host && entry.port === target.port,
  );
}
