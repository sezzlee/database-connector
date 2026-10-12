import type { ErrorFactory } from "@sezzlee/mcp-core";
import type { DbErrorCode } from "../errors.js";
import type { Lease, PoolLimits } from "../model/connection.js";
import type { QueryResult, QuerySpec } from "../model/sql.js";

type Outcome = "settled" | "aborted";

function settleSignal(signal: AbortSignal | undefined): {
  readonly promise: Promise<Outcome>;
  dispose(): void;
} {
  if (signal === undefined) {
    return {
      promise: new Promise<Outcome>(() => undefined),
      dispose: () => {},
    };
  }
  let listener: (() => void) | undefined;
  const promise = new Promise<Outcome>((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    listener = () => {
      resolve("aborted");
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (listener !== undefined) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function after(ms: number): { promise: Promise<false>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref?.();
  });
  return {
    promise,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Runs one statement on a leased connection and honours an `AbortSignal`.
 *
 * Guard: an aborted request leaves the connection protocol-indeterminate until
 * the driver reports it settled — on TDS the attention acknowledgement is still
 * in flight, so returning the connection to the pool early makes the next
 * request read the previous one's packets. The lease is therefore held until
 * `settled` settles; past `limits.cancelSettleMs` the connection is quarantined
 * rather than reused. A cancel that never settles costs one connection, never a
 * crossed result set.
 *
 * `Promise.race([run(), abort()])` is precisely the bug this function exists to
 * not be: the winner of that race abandons a request that is still on the wire.
 */
export async function runCancellable(
  lease: Lease,
  spec: QuerySpec,
  signal: AbortSignal | undefined,
  limits: PoolLimits,
  fail: ErrorFactory<DbErrorCode>,
  isBroken: (error: unknown) => boolean = () => false,
): Promise<QueryResult> {
  if (signal?.aborted)
    throw fail(
      "query_cancelled",
      "The call was cancelled before the query ran.",
    );
  const running = lease.connection.run(spec);
  const settled = running.settled;
  /** Guard: the race below may leave this promise unobserved on the losing arm. */
  settled.catch(() => undefined);

  const abort = settleSignal(signal);
  try {
    const outcome = await Promise.race<Outcome>([
      settled.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      abort.promise,
    ]);
    if (outcome === "settled") {
      return await settled;
    }

    running.cancel();
    const grace = after(limits.cancelSettleMs);
    try {
      const drained = await Promise.race([
        settled.then(
          () => true,
          (error: unknown) => {
            /** Guard: settlement can acknowledge a physically closed socket; that connection must be quarantined before cancellation masks the native error. */
            if (isBroken(error)) lease.quarantine();
            return true;
          },
        ),
        grace.promise,
      ]);
      if (!drained) {
        lease.quarantine();
      }
    } finally {
      grace.dispose();
    }
    throw fail(
      "query_cancelled",
      "The call was cancelled before the query finished.",
      "Narrow the query or raise the deadline, then call again.",
    );
  } finally {
    abort.dispose();
  }
}
