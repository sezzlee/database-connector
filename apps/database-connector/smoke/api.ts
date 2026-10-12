import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { databaseCredentialAad } from "@chat/contracts/database/credential";
import { pairDatabaseConnectorSchema } from "@chat/contracts/database/connector";
import {
  databaseExecutorHeartbeatSchema,
  databaseExecutorPollSchema,
  databaseExecutorResultSchema,
} from "@chat/contracts/database/runtime";
import { credentialKeyId, sealCredential } from "@chat/credential-seal/seal";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    "pg-port": { type: "string", default: "5432" },
    "pg-user": { type: "string", default: "smoke_reader" },
    "pg-password": { type: "string" },
    log: { type: "string" },
  },
});
const log = values.log;
const password = values["pg-password"];
if (log === undefined || password === undefined)
  throw new Error("--log and --pg-password are required");
const pgPort = Number(values["pg-port"]);
const username = values["pg-user"];

interface Device {
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly publicKey: string;
  served: boolean;
}
const devices = new Map<string, Device>();

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function job(device: Device) {
  const server = "127.0.0.1";
  const credential = await sealCredential(
    device.publicKey,
    password ?? "",
    databaseCredentialAad({
      workspaceId: device.workspaceId,
      executor: device.connectorId,
      server,
      port: pgPort,
      username,
      transport: { provider: "postgresql", sslMode: "disable" },
    }),
  );
  return {
    metadata: {
      workspaceId: device.workspaceId,
      userId: randomUUID(),
      connectionId: randomUUID(),
      configVersion: 1,
      credentialsVersion: 1,
      requestId: randomUUID(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    config: {
      provider: "postgresql",
      server,
      port: pgPort,
      database: "postgres",
      username,
      credential,
      sslMode: "disable",
      connectTimeoutMs: 15_000,
      queryTimeoutMs: 30_000,
    },
    operation: { kind: "test" },
  };
}

async function route(path: string, request: IncomingMessage): Promise<unknown> {
  const input = await body(request);
  if (path === "/api/databases/connectors/pair") {
    const pairing = pairDatabaseConnectorSchema.parse(input);
    const token = randomBytes(32).toString("base64url");
    const device: Device = {
      connectorId: randomUUID(),
      workspaceId: randomUUID(),
      publicKey: pairing.credentialPublicKey,
      served: false,
    };
    devices.set(token, device);
    return {
      token,
      connectorId: device.connectorId,
      workspaceId: device.workspaceId,
      credentialKeyId: await credentialKeyId(pairing.credentialPublicKey),
    };
  }
  const device = devices.get(
    (request.headers.authorization ?? "").replace(/^Bearer /u, ""),
  );
  if (device === undefined) return undefined;
  switch (path) {
    case "/api/databases/executor/token":
      return {
        rotated: false,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
    case "/api/databases/executor/poll": {
      const { waitMs } = databaseExecutorPollSchema.parse(input);
      if (!device.served) {
        device.served = true;
        return { job: await job(device), leaseId: randomUUID() };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(waitMs, 2_000)),
      );
      return {};
    }
    case "/api/databases/executor/heartbeat":
      databaseExecutorHeartbeatSchema.parse(input);
      return { accepted: true, cancelled: false };
    case "/api/databases/executor/results": {
      const result = databaseExecutorResultSchema.parse(input);
      appendFileSync(
        log ?? "",
        `${JSON.stringify({ connectorId: device.connectorId, response: result.response })}\n`,
      );
      return { accepted: true };
    }
    case "/api/databases/executor/cancel":
      return { accepted: true };
    default:
      return undefined;
  }
}

createServer((request, response) => {
  void route(new URL(request.url ?? "/", "http://smoke").pathname, request)
    .then((answer) => {
      response.writeHead(answer === undefined ? 401 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(answer ?? { message: "Unauthorized" }));
    })
    .catch(() => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad request" }));
    });
}).listen(Number(values.port), "127.0.0.1");
