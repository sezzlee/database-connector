import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCredentialKeyPair } from "@chat/credential-seal/seal";
import { databaseCredentialPrivateKeySchema } from "@chat/contracts/database/credential";
import { databaseConnectorMoveProofMessage } from "@chat/contracts/database/connector";
import { createDeviceState, readDeviceState } from "../src/device-state.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const EXECUTABLE = process.env.CHAT_CONNECTOR_EXECUTABLE;
const FAILURE =
  "Connector stopped; verify pairing, token permissions and API access.\n";

interface Received {
  readonly url: string | undefined;
  readonly body: {
    readonly pairingCode: string;
    readonly moveCode?: string;
    readonly proof?: string;
    readonly deviceId: string;
    readonly credentialPublicKey: string;
  };
}

type Reply = (body: Received["body"]) => unknown;

const keyIdOf = (publicKey: string) =>
  createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("base64url");

async function read(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function fakeApi(reply: Reply) {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    void read(request).then((text) => {
      const body: Received["body"] = JSON.parse(text);
      received.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply(body)));
    });
  });
  return {
    received,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("fake API has no TCP port");
          resolve(`http://127.0.0.1:${address.port}/api`);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runCli(options: {
  readonly args: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      EXECUTABLE ?? process.execPath,
      EXECUTABLE === undefined ? [CLI, ...options.args] : options.args,
      { env: options.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin);
  });
}

const pairing = (body: Received["body"]) => ({
  token: "t".repeat(64),
  connectorId: randomUUID(),
  workspaceId: randomUUID(),
  credentialKeyId: keyIdOf(body.credentialPublicKey),
});

describe("connector pairing command", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "connector-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const statePath = () => join(home, ".sezzlee", "database-connector.json");
  const allowlistPath = () =>
    join(home, ".sezzlee", "database-connector-allow.json");
  const localEnv = () => ({
    HOME: home,
    CHAT_DATABASE_ALLOW_LOCAL_HTTP: "true",
    NODE_ENV: "development",
    SEZZLEE_CONNECTOR_SECRET_STORE: "file",
  });

  it("pairs with the code typed at the prompt and keeps the matching private key in an owner-only file", async () => {
    let issued: ReturnType<typeof pairing> | undefined;
    const api = fakeApi((body) => (issued = pairing(body)));
    const code = "c".repeat(43);
    try {
      const result = await runCli({
        args: ["pair", "--api", await api.listen()],
        stdin: `${code}\n`,
        env: localEnv(),
      });

      expect(result.code).toBe(0);
      expect(api.received).toHaveLength(1);
      const sent = api.received.at(0);
      if (sent === undefined) throw new Error("no pairing request");
      expect(sent.url).toBe("/api/databases/connectors/pair");
      expect(sent.body.pairingCode).toBe(code);
      const publicKey = Buffer.from(sent.body.credentialPublicKey, "base64url");
      expect(result.stdout).toContain(
        `Key fingerprint: ${keyIdOf(sent.body.credentialPublicKey)}`,
      );

      const raw = await readFile(statePath(), "utf8");
      const { state, store } = await readDeviceState({ path: statePath() });
      expect(store).toBe("file");
      expect(raw).not.toContain(state.token);
      expect(raw).not.toContain(state.credentialPrivateKey.d);
      expect(state).toMatchObject({
        deviceId: sent.body.deviceId,
        token: issued?.token,
        connectorId: issued?.connectorId,
        workspaceId: issued?.workspaceId,
      });
      const point = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(state.credentialPrivateKey.x, "base64url"),
        Buffer.from(state.credentialPrivateKey.y, "base64url"),
      ]);
      expect(point.equals(publicKey)).toBe(true);
      expect(state.credentialPrivateKey.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (process.platform !== "win32") {
        expect((await stat(statePath())).mode & 0o777).toBe(0o600);
        expect((await stat(`${statePath()}.key`)).mode & 0o777).toBe(0o600);
        expect((await stat(join(home, ".sezzlee"))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await api.close();
    }
  }, 30_000);

  it.each([
    [
      "the server it is given",
      "SQL01.corp.local:1433\n",
      ["sql01.corp.local:1433"],
    ],
    ["nothing when the answer is skipped", "\n", undefined],
    [
      "nothing when the answer is not host:port",
      "sql01.corp.local\n",
      undefined,
    ],
  ])(
    "asks after pairing which database server to allow and allows %s",
    async (_case, answer, targets) => {
      const api = fakeApi(pairing);
      try {
        const result = await runCli({
          args: ["pair", "--api", await api.listen()],
          stdin: `${"c".repeat(43)}\n${answer}`,
          env: localEnv(),
        });

        expect(result.code).toBe(0);
        if (targets === undefined) {
          expect(result.stdout).toContain("No database server is allowed yet");
          await expect(stat(allowlistPath())).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else
          expect(JSON.parse(await readFile(allowlistPath(), "utf8"))).toEqual({
            version: 1,
            targets,
          });
      } finally {
        await api.close();
      }
    },
    30_000,
  );

  it("shows the same fingerprint and confirmation code after pairing and on the fingerprint command", async () => {
    const api = fakeApi(pairing);
    try {
      const paired = await runCli({
        args: ["pair", "--api", await api.listen()],
        stdin: `${"c".repeat(43)}\n`,
        env: localEnv(),
      });
      const sent = api.received.at(0);
      if (sent === undefined) throw new Error("no pairing request");
      const keyId = keyIdOf(sent.body.credentialPublicKey);
      const code = keyId.slice(0, 12).replace(/(.{4})(?=.)/gu, "$1 ");

      const shown = await runCli({
        args: ["fingerprint"],
        stdin: "",
        env: { HOME: home },
      });

      const expected = `Key fingerprint: ${keyId}\nConfirmation code: ${code}\n`;
      expect(paired.stdout).toContain(expected);
      expect(shown).toMatchObject({ code: 0, stdout: expected });
    } finally {
      await api.close();
    }
  }, 30_000);

  it("stores nothing when the API reports a key other than the one the device sent", async () => {
    const api = fakeApi((body) => ({
      ...pairing(body),
      credentialKeyId: keyIdOf(Buffer.alloc(65, 4).toString("base64url")),
    }));
    try {
      const result = await runCli({
        args: ["pair", "--api", await api.listen()],
        stdin: `${"c".repeat(43)}\n`,
        env: localEnv(),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(FAILURE);
      expect(api.received).toHaveLength(1);
      await expect(stat(statePath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await api.close();
    }
  }, 30_000);

  it("refuses to pair without an API address and sends nothing", async () => {
    const api = fakeApi(pairing);
    try {
      await api.listen();
      const result = await runCli({
        args: ["pair"],
        stdin: `${"c".repeat(43)}\n`,
        env: localEnv(),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "sezzlee-database-connector pair --api <url>",
      );
      expect(api.received).toHaveLength(0);
      await expect(stat(statePath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await api.close();
    }
  }, 30_000);

  it("takes no pairing code from the command line", async () => {
    const api = fakeApi(pairing);
    try {
      const result = await runCli({
        args: ["pair", "--api", await api.listen(), "c".repeat(43)],
        stdin: "\n",
        env: localEnv(),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "sezzlee-database-connector pair --api <url>",
      );
      expect(api.received).toHaveLength(0);
    } finally {
      await api.close();
    }
  }, 30_000);

  it.each([
    [
      "without the local development switch",
      { CHAT_DATABASE_ALLOW_LOCAL_HTTP: "false" },
    ],
    ["in production even with the switch", { NODE_ENV: "production" }],
  ])(
    "refuses a plain-HTTP API %s",
    async (_case, override) => {
      const api = fakeApi(pairing);
      try {
        const result = await runCli({
          args: ["pair", "--api", await api.listen()],
          stdin: `${"c".repeat(43)}\n`,
          env: { ...localEnv(), ...override },
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe(FAILURE);
        expect(api.received).toHaveLength(0);
        await expect(stat(statePath())).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await api.close();
      }
    },
    30_000,
  );
});

describe("connector allow command", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "connector-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const allow = (...args: readonly string[]) =>
    runCli({ args: ["allow", ...args], stdin: "", env: { HOME: home } });

  it("adds, lists and removes targets in the local file without contacting the API", async () => {
    expect(await allow("list")).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("No database server is allowed yet"),
    });
    expect(await allow("add", "sql01.corp.local:1433")).toMatchObject({
      code: 0,
      stdout: "Allowed sql01.corp.local:1433\n",
    });
    expect(await allow("add", "[fd00::5]:5432")).toMatchObject({ code: 0 });
    expect(await allow("list")).toMatchObject({
      code: 0,
      stdout: "sql01.corp.local:1433\n[fd00::5]:5432\n",
    });
    expect(await allow("remove", "SQL01.corp.local:1433")).toMatchObject({
      code: 0,
      stdout: "Removed sql01.corp.local:1433\n",
    });
    expect(await allow("list")).toMatchObject({
      code: 0,
      stdout: "[fd00::5]:5432\n",
    });
  }, 30_000);

  it.each([
    ["a target without a port", ["add", "sql01.corp.local"]],
    ["a wildcard", ["add", "*:1433"]],
    ["two targets at once", ["add", "sql01:1433", "sql02:1433"]],
    ["an unknown action", ["grant", "sql01:1433"]],
  ])(
    "refuses %s and leaves the allowlist untouched",
    async (_case, args) => {
      const result = await allow(...args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Usage:");
      await expect(
        stat(join(home, ".sezzlee", "database-connector-allow.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    30_000,
  );
});

describe("connector service command", () => {
  it.skipIf(EXECUTABLE !== undefined)(
    "refuses to install a service from anything but the released executable",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "connector-service-"));
      try {
        const result = await runCli({
          args: ["service", "install", "--api", "https://app.example.com/api"],
          stdin: "",
          env: { HOME: home },
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          "Install the service from the released sezzlee-database-connector executable",
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe("connector run", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "connector-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("stores a rotated token before it sends the next request with it", async () => {
    const stale = "o".repeat(64);
    const fresh = "n".repeat(64);
    const seen: { route: string | undefined; bearer: string | undefined }[] =
      [];
    const server = createServer((request, response) => {
      void read(request).then(() => {
        seen.push({
          route: request.url,
          bearer: request.headers.authorization,
        });
        if (request.url === "/api/databases/executor/token") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              rotated: true,
              token: fresh,
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            }),
          );
          return;
        }
        response.writeHead(401);
        response.end();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("fake API has no TCP port");
        resolve(address.port);
      });
    });
    try {
      const key = await generateCredentialKeyPair();
      await createDeviceState(
        {
          apiUrl: `http://127.0.0.1:${port}/api/`,
          deviceId: randomUUID(),
          connectorId: randomUUID(),
          workspaceId: randomUUID(),
          token: stale,
          credentialPrivateKey: databaseCredentialPrivateKeySchema.parse(
            key.privateKey,
          ),
        },
        {
          path: join(home, ".sezzlee", "database-connector.json"),
          preference: "file",
        },
      );

      const result = await runCli({
        args: ["run", "--concurrency=1"],
        stdin: "",
        env: {
          HOME: home,
          CHAT_DATABASE_ALLOW_LOCAL_HTTP: "true",
          NODE_ENV: "development",
        },
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("database_connector token_rotated");
      expect(seen.at(0)).toEqual({
        route: "/api/databases/executor/token",
        bearer: `Bearer ${stale}`,
      });
      expect(seen.at(1)).toEqual({
        route: "/api/databases/executor/poll",
        bearer: `Bearer ${fresh}`,
      });
      const { state } = await readDeviceState({
        path: join(home, ".sezzlee", "database-connector.json"),
      });
      expect(state.token).toBe(fresh);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe("connector move commands", () => {
  let oldHome: string;
  let newHome: string;
  let moveFile: string;
  const moveCode = "m".repeat(43);

  beforeEach(async () => {
    oldHome = await mkdtemp(join(tmpdir(), "connector-old-"));
    newHome = await mkdtemp(join(tmpdir(), "connector-new-"));
    moveFile = join(await mkdtemp(join(tmpdir(), "connector-move-")), "m.json");
  });

  afterEach(async () => {
    await rm(oldHome, { recursive: true, force: true });
    await rm(newHome, { recursive: true, force: true });
    await rm(join(moveFile, ".."), { recursive: true, force: true });
  });

  const env = (home: string) => ({
    HOME: home,
    CHAT_DATABASE_ALLOW_LOCAL_HTTP: "true",
    NODE_ENV: "development",
    SEZZLEE_CONNECTOR_SECRET_STORE: "file",
  });
  const stateOf = (home: string) =>
    join(home, ".sezzlee", "database-connector.json");

  async function exported(apiUrl: string) {
    const key = await generateCredentialKeyPair();
    const credentialPrivateKey = databaseCredentialPrivateKeySchema.parse(
      key.privateKey,
    );
    const old = {
      apiUrl: `${apiUrl}/`,
      deviceId: randomUUID(),
      connectorId: randomUUID(),
      workspaceId: randomUUID(),
      token: "o".repeat(64),
      credentialPrivateKey,
    };
    await createDeviceState(old, {
      path: stateOf(oldHome),
      preference: "file",
    });
    await runCli({
      args: ["allow", "add", "sql01.corp.local:1433"],
      stdin: "",
      env: env(oldHome),
    });
    const result = await runCli({
      args: ["move", "export", moveFile],
      stdin: "",
      env: env(oldHome),
    });
    const exportCode = /Export code: (\S+)/u.exec(result.stdout)?.[1];
    return { old, result, exportCode, keyId: key.keyId };
  }

  const answering = (connectorId?: string) =>
    fakeApi((body) => ({
      token: "n".repeat(64),
      connectorId: connectorId ?? randomUUID(),
      workspaceId: randomUUID(),
      credentialKeyId: keyIdOf(body.credentialPublicKey),
    }));

  it("moves the connector with its key and allowlist through a file that keeps both secrets sealed", async () => {
    let issued: { connectorId: string; workspaceId: string } | undefined;
    const api = fakeApi((body) => ({
      token: "n".repeat(64),
      ...(issued ?? { connectorId: randomUUID(), workspaceId: randomUUID() }),
      credentialKeyId: keyIdOf(body.credentialPublicKey),
    }));
    try {
      const { old, result, exportCode, keyId } = await exported(
        await api.listen(),
      );
      issued = { connectorId: old.connectorId, workspaceId: old.workspaceId };
      expect(result.code).toBe(0);
      if (exportCode === undefined) throw new Error("no export code shown");
      const raw = await readFile(moveFile, "utf8");
      expect(raw).not.toContain(old.credentialPrivateKey.d);
      expect(raw).not.toContain(old.token);

      const imported = await runCli({
        args: ["move", "import", moveFile],
        stdin: `${exportCode}\n${moveCode}\n`,
        env: env(newHome),
      });

      expect(imported.code).toBe(0);
      expect(api.received).toHaveLength(1);
      const sent = api.received.at(0);
      expect(sent?.url).toBe("/api/databases/connectors/move");
      expect(sent?.body).toMatchObject({ moveCode });
      const oldPublicKey = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(old.credentialPrivateKey.x, "base64url"),
        Buffer.from(old.credentialPrivateKey.y, "base64url"),
      ]).toString("base64url");
      expect(sent?.body.credentialPublicKey).toBe(oldPublicKey);
      const { kty, crv, x, y } = old.credentialPrivateKey;
      expect(
        verify(
          "sha256",
          Buffer.from(
            databaseConnectorMoveProofMessage(
              moveCode,
              sent?.body.deviceId ?? "",
            ),
          ),
          {
            key: createPublicKey({ key: { kty, crv, x, y }, format: "jwk" }),
            dsaEncoding: "ieee-p1363",
          },
          Buffer.from(sent?.body.proof ?? "", "base64url"),
        ),
      ).toBe(true);
      const { state } = await readDeviceState({ path: stateOf(newHome) });
      expect(state).toMatchObject({
        apiUrl: old.apiUrl,
        connectorId: old.connectorId,
        workspaceId: old.workspaceId,
        token: "n".repeat(64),
        credentialPrivateKey: old.credentialPrivateKey,
      });
      expect(state.deviceId).not.toBe(old.deviceId);
      expect(imported.stdout).toContain(`Key fingerprint: ${keyId}`);
      const allowed = await runCli({
        args: ["allow", "list"],
        stdin: "",
        env: env(newHome),
      });
      expect(allowed.stdout).toBe("sql01.corp.local:1433\n");
    } finally {
      await api.close();
    }
  }, 30_000);

  it("refuses a wrong export code, sends nothing and stores nothing", async () => {
    const api = answering();
    try {
      const { exportCode } = await exported(await api.listen());
      if (exportCode === undefined) throw new Error("no export code shown");
      const wrong = `${exportCode.slice(0, 5)}${exportCode[5] === "A" ? "B" : "A"}${exportCode.slice(6)}`;

      const imported = await runCli({
        args: ["move", "import", moveFile],
        stdin: `${wrong}\n${moveCode}\n`,
        env: env(newHome),
      });

      expect(imported.code).toBe(1);
      expect(api.received).toHaveLength(0);
      await expect(stat(stateOf(newHome))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await api.close();
    }
  }, 30_000);

  it("stores nothing when the API hands back another connector of the same workspace", async () => {
    let workspaceId = randomUUID();
    const api = fakeApi((body) => ({
      token: "n".repeat(64),
      connectorId: randomUUID(),
      workspaceId,
      credentialKeyId: keyIdOf(body.credentialPublicKey),
    }));
    try {
      const { old, exportCode } = await exported(await api.listen());
      workspaceId = old.workspaceId;

      const imported = await runCli({
        args: ["move", "import", moveFile],
        stdin: `${exportCode}\n${moveCode}\n`,
        env: env(newHome),
      });

      expect(imported.code).toBe(1);
      expect(api.received).toHaveLength(1);
      await expect(stat(stateOf(newHome))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await api.close();
    }
  }, 30_000);

  it("refuses to import onto a machine that already holds a connector and leaves it untouched", async () => {
    const api = answering();
    try {
      const { old, exportCode } = await exported(await api.listen());
      await createDeviceState(
        { ...old, connectorId: randomUUID(), token: "k".repeat(64) },
        { path: stateOf(newHome), preference: "file" },
      );
      const before = await readFile(stateOf(newHome), "utf8");

      const imported = await runCli({
        args: ["move", "import", moveFile],
        stdin: `${exportCode}\n${moveCode}\n`,
        env: env(newHome),
      });

      expect(imported.code).toBe(1);
      expect(api.received).toHaveLength(0);
      expect(await readFile(stateOf(newHome), "utf8")).toBe(before);
    } finally {
      await api.close();
    }
  }, 30_000);
});
