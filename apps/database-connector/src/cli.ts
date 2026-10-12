#!/usr/bin/env node
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  databaseAllowedTargetSchema,
  formatDatabaseAllowedTarget,
} from "@chat/contracts/database/allowlist";
import {
  databaseConnectorConfirmationCode,
  databaseConnectorMoveProofMessage,
  databaseExecutorTokenResponseSchema,
  pairDatabaseConnectorResponseSchema,
} from "@chat/contracts/database/connector";
import { databaseCredentialPrivateKeySchema } from "@chat/contracts/database/credential";
import { DatabaseRuntimePool } from "@chat/database-runtime";
import {
  DatabaseExecutorApi,
  databaseApiUrl,
  runDatabaseExecutor,
} from "@chat/database-runtime/runner";
import {
  credentialKeyId,
  credentialKeyring,
  credentialPublicKeyOf,
  generateCredentialKeyPair,
} from "@chat/credential-seal/seal";
import {
  createDeviceState,
  deviceStatePath,
  readDeviceState,
  writeDeviceState,
  type DeviceStateLocation,
} from "./device-state.ts";
import { openMoveBundle, sealMoveBundle } from "./move-bundle.ts";
import {
  ServiceUsageError,
  installService,
  runAsLinuxService,
  uninstallService,
  useWindowsServiceState,
} from "./service.ts";
import type { SecretStoreKind } from "./secret-store.ts";
import { allowTarget, disallowTarget, readAllowlist } from "./allowlist.ts";

const USAGE = `Usage:
  sezzlee-database-connector pair --api <url>
  sezzlee-database-connector run [--concurrency=1..32]
  sezzlee-database-connector allow add <host>:<port>
  sezzlee-database-connector allow remove <host>:<port>
  sezzlee-database-connector allow list
  sezzlee-database-connector fingerprint
  sezzlee-database-connector move export <file>
  sezzlee-database-connector move import <file>
  sezzlee-database-connector service install [--api <url>]
  sezzlee-database-connector service uninstall
  sezzlee-database-connector service allow|fingerprint|move ...
`;
const STORE_NAMES = {
  keychain: "the macOS Keychain",
  dpapi: "Windows DPAPI",
  "secret-service": "the Secret Service",
  file: "an owner-only key file",
} satisfies Record<SecretStoreKind, string>;
const MOVE_FILE_MAX = 32768;
const ROTATION_CHECK_MS = 6 * 60 * 60 * 1000;
const NOTHING_ALLOWED =
  "No database server is allowed yet. Add one with: sezzlee-database-connector allow add <host>:<port>\n";

async function main(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node 22 required");
  const [command, ...args] = process.argv.slice(2);
  const allowLocal =
    process.env.CHAT_DATABASE_ALLOW_LOCAL_HTTP === "true" &&
    process.env.NODE_ENV !== "production";
  const state: DeviceStateLocation = {
    preference:
      process.env.SEZZLEE_CONNECTOR_SECRET_STORE === "file" ? "file" : "auto",
  };
  return dispatch(command, args, allowLocal, state);
}

async function dispatch(
  command: string | undefined,
  args: readonly string[],
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  switch (command) {
    case "pair":
      return pair(args, allowLocal, state);
    case "allow":
      return allow(args);
    case "run":
      return run(args, allowLocal, state);
    case "move":
      return move(args, allowLocal, state);
    case "service":
      return service(args, allowLocal, state);
    case "fingerprint": {
      const { state: device } = await readDeviceState(state);
      stdout.write(
        fingerprint(
          await credentialKeyId(
            credentialPublicKeyOf(device.credentialPrivateKey),
          ),
        ),
      );
      return;
    }
    default:
      stdout.write(USAGE);
  }
}

function fingerprint(keyId: string): string {
  return `Key fingerprint: ${keyId}\nConfirmation code: ${databaseConnectorConfirmationCode(keyId)}\n`;
}

function openPrompt() {
  /*
   * Guard: on a terminal readline echoes each keystroke through its output, so
   * muting that output keeps a pairing, move or export code off the screen and
   * out of the scrollback. Piped input is never echoed.
   */
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) stdout.write(chunk);
      done();
    },
  });
  const prompt = createInterface({
    input: stdin,
    output: echo,
    terminal: stdin.isTTY === true,
  });
  const lines = prompt[Symbol.asyncIterator]();
  const ask = async (question: string, hidden = false) => {
    stdout.write(question);
    muted = hidden;
    const line = await lines.next();
    muted = false;
    if (hidden && stdin.isTTY === true) stdout.write("\n");
    return line.done === true ? "" : line.value.trim();
  };
  return { ask, close: () => prompt.close() };
}

function apiOption(args: readonly string[]): string | undefined {
  try {
    return parseArgs({
      args: [...args],
      options: { api: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values.api;
  } catch {
    return undefined;
  }
}

async function pair(
  args: readonly string[],
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  const endpoint = apiOption(args);
  if (endpoint === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const base = databaseApiUrl(endpoint, allowLocal);
  const { ask, close } = openPrompt();
  try {
    const pairingCode = await ask("Sezzlee pairing code: ", true);
    if (pairingCode.length < 16 || pairingCode.length > 256)
      throw new Error("Invalid pairing code");
    const deviceId = randomUUID();
    const key = await generateCredentialKeyPair();
    const { credentialKeyId, ...paired } = await new DatabaseExecutorApi(
      base,
    ).post(
      "connectors/pair",
      { pairingCode, deviceId, credentialPublicKey: key.publicKey },
      pairDatabaseConnectorResponseSchema,
      AbortSignal.timeout(15000),
    );
    if (credentialKeyId !== key.keyId)
      throw new Error("Connector key was not registered as sent");
    const store = await createDeviceState(
      {
        apiUrl: base.href,
        deviceId,
        ...paired,
        credentialPrivateKey: databaseCredentialPrivateKeySchema.parse(
          key.privateKey,
        ),
      },
      state,
    );
    stdout.write(
      `Connector paired.\n${fingerprint(key.keyId)}Secrets are kept in ${STORE_NAMES[store]}.\n`,
    );
    const target = databaseAllowedTargetSchema.safeParse(
      await ask(
        "Database server this connector may reach (host:port, Enter to skip): ",
      ),
    );
    if (target.success) {
      await allowTarget(target.data);
      stdout.write(`Allowed ${formatDatabaseAllowedTarget(target.data)}\n`);
    } else stdout.write(NOTHING_ALLOWED);
    stdout.write("Start with sezzlee-database-connector run.\n");
  } finally {
    close();
  }
}

async function allow(args: readonly string[]): Promise<void> {
  const [action, value] = args;
  if (action === "list" && args.length === 1) {
    const targets = await readAllowlist();
    stdout.write(
      targets.length === 0
        ? NOTHING_ALLOWED
        : targets
            .map((target) => `${formatDatabaseAllowedTarget(target)}\n`)
            .join(""),
    );
    return;
  }
  const target = databaseAllowedTargetSchema.safeParse(value);
  if (
    (action !== "add" && action !== "remove") ||
    args.length !== 2 ||
    !target.success
  ) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const shown = formatDatabaseAllowedTarget(target.data);
  if (action === "add")
    stdout.write(
      (await allowTarget(target.data))
        ? `Allowed ${shown}\n`
        : `${shown} is already allowed\n`,
    );
  else
    stdout.write(
      (await disallowTarget(target.data))
        ? `Removed ${shown}\n`
        : `${shown} was not allowed\n`,
    );
}

async function service(
  args: readonly string[],
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  const [action, ...rest] = args;
  if (action === "install") {
    const api = apiOption(rest);
    if (api === undefined && rest.length > 0) {
      process.stderr.write(USAGE);
      process.exitCode = 1;
      return;
    }
    stdout.write(
      `${await installService({
        api,
        pair: (url) => pair(["--api", url], allowLocal, state),
        paired: () => holdsConnector(state),
      })}\n`,
    );
    return;
  }
  if (action === "uninstall" && rest.length === 0) {
    stdout.write(`${await uninstallService()}\n`);
    return;
  }
  if (action === "allow" || action === "fingerprint" || action === "move") {
    if (process.platform === "linux") return runAsLinuxService(args);
    if (process.platform === "win32") useWindowsServiceState();
    return dispatch(action, rest, allowLocal, state);
  }
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function move(
  args: readonly string[],
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  const [action, file] = args;
  if (args.length !== 2 || file === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (action === "export") return exportConnector(file, state);
  if (action === "import") return importConnector(file, allowLocal, state);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function exportConnector(
  file: string,
  state: DeviceStateLocation,
): Promise<void> {
  const { state: device } = await readDeviceState(state);
  const sealed = sealMoveBundle({
    apiUrl: device.apiUrl,
    connectorId: device.connectorId,
    workspaceId: device.workspaceId,
    credentialPrivateKey: device.credentialPrivateKey,
    allowlist: (await readAllowlist()).map(formatDatabaseAllowedTarget),
  });
  await writeFile(file, sealed.file, { mode: 0o600, flag: "wx" });
  stdout.write(
    `Move file written to ${file}\nExport code: ${sealed.exportCode}\nCopy the file to the new machine and run: sezzlee-database-connector move import <file>\nThe export code is shown only here. This machine keeps working until the import succeeds.\n`,
  );
}

async function importConnector(
  file: string,
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  if (await exists(state.path ?? deviceStatePath()))
    throw new Error("This machine already holds a connector");
  const sealed = await readFile(file, "utf8");
  if (sealed.length > MOVE_FILE_MAX) throw new Error("Move file is too large");
  const { ask, close } = openPrompt();
  try {
    const bundle = openMoveBundle(sealed, await ask("Export code: ", true));
    const moveCode = await ask("Sezzlee move code: ", true);
    if (moveCode.length < 16 || moveCode.length > 256)
      throw new Error("Invalid move code");
    const credentialPublicKey = credentialPublicKeyOf(
      bundle.credentialPrivateKey,
    );
    const keyId = await credentialKeyId(credentialPublicKey);
    const deviceId = randomUUID();
    const { kty, crv, x, y, d } = bundle.credentialPrivateKey;
    const proof = sign(
      "sha256",
      Buffer.from(databaseConnectorMoveProofMessage(moveCode, deviceId)),
      {
        key: createPrivateKey({ key: { kty, crv, x, y, d }, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
    ).toString("base64url");
    const moved = await new DatabaseExecutorApi(
      databaseApiUrl(bundle.apiUrl, allowLocal),
    ).post(
      "connectors/move",
      { moveCode, deviceId, credentialPublicKey, proof },
      pairDatabaseConnectorResponseSchema,
      AbortSignal.timeout(15000),
    );
    if (
      moved.connectorId !== bundle.connectorId ||
      moved.workspaceId !== bundle.workspaceId ||
      moved.credentialKeyId !== keyId
    )
      throw new Error("The API moved another connector");
    const store = await createDeviceState(
      {
        apiUrl: bundle.apiUrl,
        deviceId,
        connectorId: moved.connectorId,
        workspaceId: moved.workspaceId,
        token: moved.token,
        credentialPrivateKey: bundle.credentialPrivateKey,
      },
      state,
    );
    for (const target of bundle.allowlist) {
      const parsed = databaseAllowedTargetSchema.safeParse(target);
      if (parsed.success) await allowTarget(parsed.data);
    }
    stdout.write(
      `Connector moved.\n${fingerprint(keyId)}Secrets are kept in ${STORE_NAMES[store]}.\nStart with sezzlee-database-connector run.\n`,
    );
  } finally {
    close();
  }
}

/**
 * Guard: a service installs over existing state only when that state passes
 * the owner and ACL checks a read applies, so a file someone planted in the
 * state directory stops the install instead of being run.
 */
async function holdsConnector(state: DeviceStateLocation): Promise<boolean> {
  if (!(await exists(state.path ?? deviceStatePath()))) return false;
  await readDeviceState(state);
  return true;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    },
  );
}

async function run(
  args: readonly string[],
  allowLocal: boolean,
  state: DeviceStateLocation,
): Promise<void> {
  const concurrency = Number(
    args
      .find((argument) => argument.startsWith("--concurrency="))
      ?.slice("--concurrency=".length) ?? "4",
  );
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    stdout.write(USAGE);
    return;
  }
  const opened = await readDeviceState(state);
  let device = opened.state;
  stdout.write(`database_connector secret_store ${opened.store}\n`);
  if ((await readAllowlist()).length === 0) stdout.write(NOTHING_ALLOWED);
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  const api = new DatabaseExecutorApi(
    databaseApiUrl(device.apiUrl, allowLocal),
    device.token,
  );
  /*
   * Guard: the rotated token is written to disk before the client switches to
   * it. A crash in between leaves the stored token as the one the api keeps
   * accepting for the overlap hour, and rotating from it again is allowed.
   */
  const rotate = async () => {
    try {
      const answer = await api.post(
        "executor/token",
        {},
        databaseExecutorTokenResponseSchema,
        AbortSignal.timeout(15000),
      );
      if (!answer.rotated) return;
      device = { ...device, token: answer.token };
      await writeDeviceState(device, state);
      api.useToken(answer.token);
      stdout.write("database_connector token_rotated\n");
    } catch {
      stdout.write("database_connector token_rotation_failed\n");
    }
  };
  await rotate();
  const rotation = setInterval(() => void rotate(), ROTATION_CHECK_MS);
  const pool = new DatabaseRuntimePool({
    executor: {
      kind: "connector",
      connectorId: device.connectorId,
      workspaceId: device.workspaceId,
      allowlist: () => readAllowlist(),
    },
    keys: await credentialKeyring([device.credentialPrivateKey]),
    maxSources: 64,
    idleMs: 300000,
  });
  try {
    await runDatabaseExecutor({
      api,
      pool,
      concurrency,
      signal: stop.signal,
      onEvent: (event) => {
        if (event !== "polled") stdout.write(`database_connector ${event}\n`);
      },
    });
  } finally {
    clearInterval(rotation);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof ServiceUsageError
      ? `${error.message}\n`
      : "Connector stopped; verify pairing, token permissions and API access.\n",
  );
  process.exitCode = 1;
});
