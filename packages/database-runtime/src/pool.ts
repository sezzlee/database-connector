import { createHash } from "node:crypto";
import {
  databaseJobBudgetCeilingMs,
  managedTransportAllowed,
} from "@chat/contracts/database/database";
import {
  databaseRuntimeRequestSchema,
  type DatabaseRuntimeConfig,
  type DatabaseRuntimeRequest,
  type DatabaseRuntimeResponse,
  type DatabaseRuntimeResult,
  type DatabaseRuntimeTool,
} from "@chat/contracts/database/runtime";
import type { ToolCallOutcome } from "@chat/contracts/integration/tool-result";
import {
  databaseReadinessPermitsQueries,
  type DatabaseReadiness,
} from "@chat/contracts/database/connection";
import { createRuntimeSession } from "./session.ts";
import { cancellable } from "./cancellation.ts";
import { classifyRuntimeFailure } from "./provider-policy.ts";
import {
  CredentialRejectedError,
  openCredential,
} from "@chat/credential-seal/seal";
import { databaseCredentialAad } from "@chat/contracts/database/credential";
import {
  databaseTargetAllowed,
  type DatabaseAllowedTarget,
} from "@chat/contracts/database/allowlist";

const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "describe_connection",
  "search_catalog",
  "describe_table",
  "run_query",
]);

export interface RuntimeSession {
  listTools(signal?: AbortSignal): Promise<readonly DatabaseRuntimeTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome>;
  /** Only fixed inventory statements supplied by this package use this path. */
  probe(signal?: AbortSignal): Promise<void | DatabaseReadiness>;
  discoverDatabases(signal?: AbortSignal): Promise<readonly string[]>;
  close(): Promise<void>;
}
interface PoolEntry {
  readonly session: Promise<RuntimeSession>;
  readonly connection: string;
  readonly version: number;
  readonly fingerprint: string;
  touched: number;
  active: number;
}
export type RuntimeExecutor =
  | { readonly kind: "managed" }
  | {
      readonly kind: "connector";
      readonly connectorId: string;
      readonly workspaceId: string;
      /** Read before every job, so a target the customer adds or removes applies to the next one. */
      readonly allowlist: () => Promise<readonly DatabaseAllowedTarget[]>;
    };
export interface RuntimePoolOptions {
  readonly executor: RuntimeExecutor;
  readonly keys: ReadonlyMap<string, JsonWebKey>;
  readonly factory?: (
    config: DatabaseRuntimeConfig,
    password: string,
    mode: "managed" | "connector",
    signal?: AbortSignal,
  ) => Promise<RuntimeSession>;
  readonly maxSources?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
}

class CredentialKeyUnavailableError extends Error {}

export class DatabaseRuntimePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly versions = new Map<string, number>();
  private readonly options: RuntimePoolOptions;
  private readonly factory: NonNullable<RuntimePoolOptions["factory"]>;
  private readonly now: () => number;
  constructor(options: RuntimePoolOptions) {
    this.options = options;
    this.factory = options.factory ?? createRuntimeSession;
    this.now = options.now ?? Date.now;
  }

  async execute(
    input: DatabaseRuntimeRequest,
    abort?: AbortSignal,
  ): Promise<DatabaseRuntimeResponse> {
    const parsed = databaseRuntimeRequestSchema.safeParse(input);
    const base = {
      requestId: input.metadata.requestId,
      configVersion: input.metadata.configVersion,
    };
    if (!parsed.success)
      return { ...base, ok: false, error: "invalid_operation" };
    const request = parsed.data,
      remaining = Date.parse(request.metadata.deadline) - this.now();
    if (remaining <= 0) return { ...base, ok: false, error: "timeout" };
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        Math.max(1, Math.min(remaining, databaseJobBudgetCeilingMs)),
      ),
      ...(abort === undefined ? [] : [abort]),
    ]);
    const group = `${request.metadata.workspaceId}:${request.metadata.connectionId}`;
    if ((this.versions.get(group) ?? 0) > request.metadata.configVersion)
      return { ...base, ok: false, error: "stale_configuration" };
    const executor = this.options.executor;
    if (executor.kind === "managed" && !managedTransportAllowed(request.config))
      return { ...base, ok: false, error: "certificate_failed" };
    if (
      executor.kind === "connector" &&
      request.metadata.workspaceId !== executor.workspaceId
    )
      return { ...base, ok: false, error: "invalid_operation" };
    if (
      request.operation.kind === "tools/call" &&
      !ALLOWED_TOOLS.has(request.operation.name)
    )
      return { ...base, ok: false, error: "invalid_operation" };
    let entry: PoolEntry | undefined;
    try {
      signal.throwIfAborted();
      if (request.operation.kind === "close") {
        await cancellable(
          this.invalidate(group, request.metadata.configVersion),
          signal,
        );
        await cancellable(
          Promise.all(
            [...this.entries]
              .filter(([, value]) => value.connection === group)
              .map(([key, value]) => this.remove(key, value)),
          ),
          signal,
        );
        return { ...base, ok: true, result: { kind: "close", closed: true } };
      }
      if (
        executor.kind === "connector" &&
        !(await this.allows(executor, request.config, signal))
      )
        return { ...base, ok: false, error: "target_not_allowed" };
      await cancellable(
        this.invalidate(group, request.metadata.configVersion),
        signal,
      );
      await cancellable(this.sweep(), signal);
      signal.throwIfAborted();
      const database =
        request.operation.kind === "validate_source"
          ? request.operation.database
          : request.config.database;
      const config = { ...request.config, database };
      const key = `${group}:${request.metadata.userId}:${request.metadata.sourceId ?? "inventory"}:${database}:${request.metadata.configVersion}:${request.metadata.credentialsVersion}`;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(config))
        .digest("hex");
      entry = this.entries.get(key);
      if (entry !== undefined && entry.fingerprint !== fingerprint)
        return { ...base, ok: false, error: "stale_configuration" };
      if (entry === undefined) {
        while (this.entries.size >= (this.options.maxSources ?? 64)) {
          if (this.entries.has(key)) break;
          const idle = [...this.entries]
            .filter(([, value]) => value.active === 0)
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (idle === undefined)
            return { ...base, ok: false, error: "execution_failed" };
          await cancellable(this.remove(idle[0], idle[1]), signal);
        }
        signal.throwIfAborted();
        if ((this.versions.get(group) ?? 0) > request.metadata.configVersion)
          return { ...base, ok: false, error: "stale_configuration" };
        entry = this.entries.get(key);
        if (entry !== undefined && entry.fingerprint !== fingerprint)
          return { ...base, ok: false, error: "stale_configuration" };
        if (entry === undefined) {
          const session = this.open(
            config,
            request.metadata.workspaceId,
            signal,
          );
          entry = {
            session,
            connection: group,
            version: request.metadata.configVersion,
            fingerprint,
            touched: this.now(),
            active: 0,
          };
          this.entries.set(key, entry);
          void session.catch(() => {
            if (this.entries.get(key)?.session === session)
              this.entries.delete(key);
          });
        }
      }
      entry.active += 1;
      entry.touched = this.now();
      const session = await cancellable(entry.session, signal);
      signal.throwIfAborted();
      let result: DatabaseRuntimeResult;
      switch (request.operation.kind) {
        case "test": {
          const readiness = await session.probe(signal);
          result = {
            kind: "test",
            connected: true,
            ...(readiness === undefined ? {} : { readiness }),
          };
          break;
        }
        case "discover": {
          result = {
            kind: "discover",
            databases: [...(await session.discoverDatabases(signal))],
          };
          break;
        }
        case "validate_source": {
          const readiness = await session.probe(signal);
          if (
            readiness !== undefined &&
            !databaseReadinessPermitsQueries(readiness)
          )
            return { ...base, ok: false, error: "principal_not_read_only" };
          result = { kind: "validate_source", valid: true, database };
          break;
        }
        case "tools/list":
          result = {
            kind: "tools/list",
            tools: [...(await session.listTools(signal))].filter((tool) =>
              ALLOWED_TOOLS.has(tool.name),
            ),
          };
          break;
        case "tools/call": {
          const outcome = await session.callTool(
            request.operation.name,
            request.operation.arguments,
            signal,
          );
          result = {
            kind: "tools/call",
            outcome: { ...outcome, blocks: [...outcome.blocks] },
          };
          break;
        }
      }
      signal.throwIfAborted();
      if ((this.versions.get(group) ?? 0) > request.metadata.configVersion)
        return { ...base, ok: false, error: "stale_configuration" };
      return { ...base, ok: true, result };
    } catch (error) {
      return {
        ...base,
        ok: false,
        error:
          error instanceof CredentialRejectedError
            ? "credential_rejected"
            : error instanceof CredentialKeyUnavailableError
              ? "credential_key_unavailable"
              : classifyRuntimeFailure(error, request.config.provider, signal),
      };
    } finally {
      if (entry !== undefined && entry.active > 0) {
        entry.active -= 1;
        entry.touched = this.now();
      }
    }
  }

  /**
   * Guard: the AAD names this executor from its own configuration, never from
   * the job, so an envelope the api redirects to another device, workspace or
   * server fails to open here instead of handing over the password.
   */
  private async open(
    config: DatabaseRuntimeConfig,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<RuntimeSession> {
    const { keys, executor } = this.options;
    const key = keys.get(config.credential.kid);
    if (key === undefined) throw new CredentialKeyUnavailableError();
    const password = await openCredential(
      key,
      config.credential,
      databaseCredentialAad({
        workspaceId:
          executor.kind === "connector" ? executor.workspaceId : workspaceId,
        executor:
          executor.kind === "connector" ? executor.connectorId : "managed",
        server: config.server,
        port: config.port,
        username: config.username,
        transport: config,
      }),
    );
    signal.throwIfAborted();
    return this.factory(config, password, executor.kind, signal);
  }

  /** Guard: an allowlist that cannot be read denies every target instead of failing open. */
  private async allows(
    executor: Extract<RuntimeExecutor, { kind: "connector" }>,
    config: DatabaseRuntimeConfig,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return databaseTargetAllowed(
        await cancellable(executor.allowlist(), signal),
        config,
      );
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  private async invalidate(connection: string, version: number): Promise<void> {
    if (!this.versions.has(connection) && this.versions.size >= 4096) {
      const dormant = [...this.versions.keys()].find(
        (key) =>
          ![...this.entries.values()].some((entry) => entry.connection === key),
      );
      if (dormant !== undefined) this.versions.delete(dormant);
    }
    this.versions.set(
      connection,
      Math.max(this.versions.get(connection) ?? 0, version),
    );
    await Promise.all(
      [...this.entries]
        .filter(
          ([, entry]) =>
            entry.connection === connection && entry.version < version,
        )
        .map(([key, entry]) => this.remove(key, entry)),
    );
  }
  async sweep(): Promise<void> {
    await Promise.all(
      [...this.entries]
        .filter(
          ([, entry]) =>
            entry.active === 0 &&
            entry.touched < this.now() - (this.options.idleMs ?? 300000),
        )
        .map(([key, entry]) => this.remove(key, entry)),
    );
  }
  private async remove(key: string, entry: PoolEntry): Promise<void> {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    const closing = entry.session
      .then((session) => session.close())
      .catch(() => undefined);
    await cancellable(closing, AbortSignal.timeout(5000)).catch(
      () => undefined,
    );
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.entries].map(([key, entry]) => this.remove(key, entry)),
    );
    this.versions.clear();
  }
}
