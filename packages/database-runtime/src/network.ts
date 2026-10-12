import { lookup } from "node:dns/promises";
import {
  createConnection,
  isIP,
  type Socket,
  type LookupFunction,
} from "node:net";
import {
  bareHost,
  isPrivateAddress,
  isPublicUnicastAddress,
  ipv6Groups,
} from "@chat/contracts/common/network-address";
import { cancellable } from "./cancellation.ts";

interface Address {
  readonly address: string;
  readonly family: number;
}
export interface PinnedTarget {
  readonly hostname: string;
  readonly address: string;
  readonly port: number;
  /** A managed executor reaches public unicast peers only; a connector reaches its own network. */
  readonly reach: "public" | "network";
}
type Resolver = (hostname: string) => Promise<readonly Address[]>;

export async function resolveManagedTarget(
  server: string,
  port: number,
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
  signal: AbortSignal = AbortSignal.timeout(10000),
): Promise<PinnedTarget> {
  const hostname = bareHost(server);
  if (isPrivateAddress(hostname)) throw new Error("blocked_address");
  const addresses =
    isIP(hostname) !== 0
      ? [{ address: hostname, family: isIP(hostname) }]
      : await cancellable(resolve(hostname), signal);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicUnicastAddress(address))
  )
    throw new Error("blocked_address");
  const selected = addresses[0];
  if (selected === undefined) throw new Error("blocked_address");
  return { hostname, port, address: selected.address, reach: "public" };
}

/**
 * Guard: the connector resolves an allowlisted name once and dials only that
 * address, so the driver can neither resolve again nor follow a SQL Server
 * routing redirect to a host the customer never allowed.
 */
export async function resolveConnectorTarget(
  server: string,
  port: number,
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
  signal: AbortSignal = AbortSignal.timeout(10000),
): Promise<PinnedTarget> {
  const hostname = bareHost(server);
  const addresses =
    isIP(hostname) !== 0
      ? [{ address: hostname, family: isIP(hostname) }]
      : await cancellable(resolve(hostname), signal);
  const selected = addresses[0];
  if (selected === undefined) throw new Error("blocked_address");
  return { hostname, port, address: selected.address, reach: "network" };
}

/** The driver may not resolve again or follow a SQL routing redirect. */
export function pinnedConnector(target: PinnedTarget) {
  return async (
    options: {
      readonly host: string;
      readonly port: number;
      readonly localAddress?: string;
    },
    _lookup: LookupFunction,
    signal?: AbortSignal,
  ): Promise<Socket> => {
    if (
      bareHost(options.host) !== target.hostname ||
      options.port !== target.port
    )
      throw new Error("blocked_address");
    signal?.throwIfAborted();
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({
        host: target.address,
        port: target.port,
        ...(signal === undefined ? {} : { signal }),
      });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        const peer = socket.remoteAddress;
        const normalized =
          peer?.startsWith("::ffff:") === true ? peer.slice(7) : peer;
        const identity = (ip: string) =>
          isIP(ip) === 6 ? ipv6Groups(ip)?.join(":") : ip;
        if (
          normalized === undefined ||
          (target.reach === "public" && !isPublicUnicastAddress(normalized)) ||
          identity(normalized) !== identity(target.address)
        ) {
          fail(new Error("blocked_address"));
          return;
        }
        socket.removeListener("error", fail);
        resolve(socket);
      });
    });
  };
}
