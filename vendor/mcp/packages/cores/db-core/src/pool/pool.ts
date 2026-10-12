import type { ErrorFactory } from "@sezzlee/mcp-core";
import type { DbErrorCode } from "../errors.js";
import type {
  ConnectionPool,
  DriverAdapter,
  DriverConnection,
  Lease,
  PoolLimits,
  RunningQuery,
} from "../model/connection.js";
import type { QuerySpec } from "../model/sql.js";

export interface ConnectionPoolSpec<TConfig> {
  readonly driver: DriverAdapter<TConfig>;
  readonly config: TConfig;
  readonly limits: PoolLimits;
  readonly fail: ErrorFactory<DbErrorCode>;
  readonly sessionSetup: readonly QuerySpec[];
}

interface Waiter {
  readonly resolve: (connection: DriverConnection) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  dispose(): void;
  settled: boolean;
}

export function createConnectionPool<TConfig>(
  spec: ConnectionPoolSpec<TConfig>,
): ConnectionPool {
  const { driver, config, limits, fail } = spec;
  const idle: DriverConnection[] = [];
  const waiters: Waiter[] = [];
  const openings = new Set<() => void>();
  let opened = 0;
  let generation = 0;
  let closed = false;

  function open(signal?: AbortSignal): Promise<DriverConnection> {
    return new Promise<DriverConnection>((resolve, reject) => {
      const controller = new AbortController();
      let connection: DriverConnection | undefined;
      let running: RunningQuery | undefined;
      let finished = false;
      let destroyed = false;
      const destroy = () => {
        if (connection === undefined || destroyed) return;
        destroyed = true;
        void connection.destroy().catch(() => undefined);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        openings.delete(shutdown);
      };
      const stop = (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.abort();
        try {
          running?.cancel();
        } catch {
          running = undefined;
        }
        destroy();
        reject(error);
      };
      const aborted = () =>
        stop(
          fail(
            "query_cancelled",
            "The call was cancelled while opening a connection.",
          ),
        );
      const shutdown = () =>
        stop(fail("internal_error", "The server is shutting down."));
      const timer = setTimeout(
        () =>
          stop(
            fail(
              "connection_failed",
              `The connection was not established within ${limits.connectTimeoutMs} ms.`,
              "Check that the server is reachable and accepting connections.",
            ),
          ),
        limits.connectTimeoutMs,
      );
      timer.unref?.();
      openings.add(shutdown);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      /** Guard: deadline, cancellation and shutdown own late connections too; abandoning only the opening promise leaks a physical socket. */
      void (async () => {
        try {
          connection = await driver.open(config, controller.signal);
          if (finished) {
            destroy();
            return;
          }
          for (const statement of spec.sessionSetup) {
            running = connection.run(statement);
            await running.settled;
            running = undefined;
            if (finished) return;
          }
          finished = true;
          cleanup();
          resolve(connection);
        } catch (error) {
          stop(error);
        }
      })();
    });
  }

  function handOff(connection: DriverConnection): boolean {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter === undefined || waiter.settled) {
        continue;
      }
      waiter.settled = true;
      waiter.dispose();
      waiter.resolve(connection);
      return true;
    }
    return false;
  }

  function serveWaiters(): void {
    while (!closed && opened < limits.maxConnections) {
      const waiter = waiters.shift();
      if (waiter === undefined) return;
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.dispose();
      opened += 1;
      void open(waiter.signal).then(waiter.resolve, (error: unknown) => {
        opened -= 1;
        waiter.reject(error);
        serveWaiters();
      });
    }
  }

  function discard(connection: DriverConnection): void {
    opened -= 1;
    /**
     * Guard: the generation is the "this pool reconnected" signal. Anything
     * cached against a connection — a cursor, a schema snapshot — is only valid
     * within one generation, so it has to move even though F1 caches nothing.
     */
    generation += 1;
    void connection.destroy().catch(() => undefined);
    serveWaiters();
  }

  function leaseFor(connection: DriverConnection): Lease {
    let released = false;
    let poisoned = false;
    const born = generation;
    return {
      connection,
      generation: born,
      quarantine: () => {
        poisoned = true;
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (poisoned || closed) {
          discard(connection);
          return;
        }
        if (!handOff(connection)) {
          idle.push(connection);
        }
      },
    };
  }

  return {
    get generation() {
      return generation;
    },

    async acquire(signal?: AbortSignal): Promise<Lease> {
      if (closed) {
        throw fail("internal_error", "The connection pool is closed.");
      }
      if (signal?.aborted === true) {
        throw fail("query_cancelled", "The call was cancelled before it ran.");
      }
      const free = idle.pop();
      if (free !== undefined) {
        return leaseFor(free);
      }
      if (opened < limits.maxConnections) {
        opened += 1;
        try {
          return leaseFor(await open(signal));
        } catch (error) {
          opened -= 1;
          serveWaiters();
          throw error;
        }
      }
      if (waiters.length >= limits.maxQueueDepth) {
        throw fail(
          "resource_limit",
          `${limits.maxQueueDepth} calls are already waiting for a connection.`,
          "Retry once the calls in flight have finished.",
        );
      }
      const connection = await new Promise<DriverConnection>(
        (resolve, reject) => {
          const aborted = () => {
            if (waiter.settled) return;
            waiter.settled = true;
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            waiter.dispose();
            reject(
              fail(
                "query_cancelled",
                "The call was cancelled while it waited for a connection.",
              ),
            );
          };
          const waiter: Waiter = {
            resolve,
            reject,
            settled: false,
            ...(signal === undefined ? {} : { signal }),
            dispose: () => signal?.removeEventListener("abort", aborted),
          };
          waiters.push(waiter);
          signal?.addEventListener("abort", aborted, { once: true });
        },
      );
      return leaseFor(connection);
    },

    async close(): Promise<void> {
      closed = true;
      for (const shutdown of [...openings]) shutdown();
      for (const waiter of waiters.splice(0)) {
        if (!waiter.settled) {
          waiter.settled = true;
          waiter.dispose();
          waiter.reject(fail("internal_error", "The server is shutting down."));
        }
      }
      const open = idle.splice(0);
      opened -= open.length;
      await Promise.all(
        open.map((connection) => connection.destroy().catch(() => undefined)),
      );
    },
  };
}
