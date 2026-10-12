import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  pinnedConnector,
  resolveConnectorTarget,
  resolveManagedTarget,
} from "../src/network.ts";

vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  createConnection: vi.fn(),
}));

function socketWithPeer(address: string): Socket {
  const socket = Object.assign(new EventEmitter(), {
    remoteAddress: address,
    destroy: vi.fn(),
  });
  queueMicrotask(() => socket.emit("connect"));
  return socket as unknown as Socket;
}

describe("managed SQL egress", () => {
  it("rejects loopback, private IPv4 and mapped IPv6 without resolving", async () => {
    for (const server of [
      "localhost",
      "127.0.0.1",
      "10.2.3.4",
      "169.254.169.254",
      "::ffff:127.0.0.1",
    ])
      await expect(
        resolveManagedTarget(server, 1433, async () => []),
      ).rejects.toThrow();
  });

  it("rejects a hostname whose DNS response contains a private address", async () => {
    await expect(
      resolveManagedTarget("sql.example.com", 1433, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow();
  });

  it("pins a public address while retaining the TLS hostname", async () => {
    const target = await resolveManagedTarget(
      "sql.example.com",
      1433,
      async () => [{ address: "8.8.8.8", family: 4 }],
    );
    expect(target).toEqual({
      address: "8.8.8.8",
      hostname: "sql.example.com",
      port: 1433,
      reach: "public",
    });
  });

  it("uses only the resolved IP and refuses routing or mismatched actual socket peers", async () => {
    const target = {
      address: "8.8.8.8",
      hostname: "sql.example.com",
      port: 1433,
      reach: "public",
    } as const;
    const connect = pinnedConnector(target),
      lookup = vi.fn();
    vi.mocked(createConnection).mockReturnValueOnce(socketWithPeer("8.8.8.8"));
    await connect({ host: target.hostname, port: 1433 }, lookup);
    expect(createConnection).toHaveBeenLastCalledWith({
      host: "8.8.8.8",
      port: 1433,
    });
    expect(lookup).not.toHaveBeenCalled();
    await expect(
      connect({ host: "10.0.0.1", port: 1433 }, lookup),
    ).rejects.toThrow();
    vi.mocked(createConnection).mockReturnValueOnce(socketWithPeer("10.0.0.1"));
    await expect(
      connect({ host: target.hostname, port: 1433 }, lookup),
    ).rejects.toThrow();
  });

  it("compares IPv6 peers by address rather than textual formatting", async () => {
    vi.mocked(createConnection).mockReturnValueOnce(
      socketWithPeer("2606:4700:4700::1111"),
    );
    await expect(
      pinnedConnector({
        address: "2606:4700:4700:0:0:0:0:1111",
        hostname: "sql.example.com",
        port: 1433,
        reach: "public",
      })({ host: "sql.example.com", port: 1433 }, vi.fn()),
    ).resolves.toBeDefined();
  });

  it("rejects documentation, multicast, mapped and tunneling destinations", async () => {
    for (const address of [
      "192.0.2.1",
      "203.0.113.1",
      "ff02::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "64:ff9b::a00:1",
    ])
      await expect(resolveManagedTarget(address, 1433)).rejects.toThrow();
  });
});

describe("connector SQL egress", () => {
  it("resolves an allowlisted name once and keeps the private address it got", async () => {
    const resolve = vi.fn(async () => [
      { address: "10.0.0.5", family: 4 },
      { address: "10.0.0.6", family: 4 },
    ]);
    expect(
      await resolveConnectorTarget("SQL01.corp.local.", 1433, resolve),
    ).toEqual({
      hostname: "sql01.corp.local",
      address: "10.0.0.5",
      port: 1433,
      reach: "network",
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("dials only the resolved private address and refuses a SQL routing redirect to another host", async () => {
    const connect = pinnedConnector({
      address: "10.0.0.5",
      hostname: "sql01.corp.local",
      port: 1433,
      reach: "network",
    });
    vi.mocked(createConnection).mockReturnValueOnce(socketWithPeer("10.0.0.5"));
    await expect(
      connect({ host: "sql01.corp.local", port: 1433 }, vi.fn()),
    ).resolves.toBeDefined();
    expect(createConnection).toHaveBeenLastCalledWith({
      host: "10.0.0.5",
      port: 1433,
    });
    await expect(
      connect({ host: "sql02.corp.local", port: 1433 }, vi.fn()),
    ).rejects.toThrow("blocked_address");
    await expect(
      connect({ host: "sql01.corp.local", port: 11433 }, vi.fn()),
    ).rejects.toThrow("blocked_address");
    vi.mocked(createConnection).mockReturnValueOnce(socketWithPeer("10.0.0.6"));
    await expect(
      connect({ host: "sql01.corp.local", port: 1433 }, vi.fn()),
    ).rejects.toThrow("blocked_address");
  });
});
