import { describe, expect, it } from "vitest";
import { classifyRuntimeFailure } from "../src/provider-policy.ts";

describe("provider failure vocabulary", () => {
  const signal = new AbortController().signal;

  it.each([
    ["mssql", { code: "ELOGIN" }, "authentication_failed"],
    ["mssql", { number: 18456 }, "authentication_failed"],
    [
      "mssql",
      { originalError: { info: { number: 4060 } } },
      "database_unavailable",
    ],
    ["postgresql", { code: "28P01" }, "authentication_failed"],
    ["postgresql", { code: "28000" }, "authentication_failed"],
    ["postgresql", { code: "3D000" }, "database_unavailable"],
    ["postgresql", { code: "57014" }, "cancelled"],
    [
      "postgresql",
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
      "timeout",
    ],
    ["postgresql", { code: "CERT_HAS_EXPIRED" }, "certificate_failed"],
    [
      "postgresql",
      Object.assign(new Error("The server does not support SSL connections"), {
        code: "PG_TLS_UNSUPPORTED",
      }),
      "tls_unsupported",
    ],
    [
      "postgresql",
      Object.assign(
        new Error(
          "The server does not support SSL connections (PG_TLS_UNSUPPORTED)",
        ),
        { code: "connection_failed" },
      ),
      "tls_unsupported",
    ],
    ["postgresql", { code: "authentication_failed" }, "authentication_failed"],
    ["mssql", { code: "query_timeout" }, "timeout"],
    ["mssql", { code: "query_cancelled" }, "cancelled"],
    [
      "postgresql",
      Object.assign(
        new Error("Connection failed (DEPTH_ZERO_SELF_SIGNED_CERT)"),
        { code: "connection_failed" },
      ),
      "certificate_failed",
    ],
  ] as const)(
    "maps %s failures into the shared vocabulary",
    (provider, error, expected) => {
      expect(classifyRuntimeFailure(error, provider, signal)).toBe(expected);
    },
  );

  it("gives caller cancellation precedence over a native query cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      classifyRuntimeFailure(
        { code: "57014" },
        "postgresql",
        controller.signal,
      ),
    ).toBe("cancelled");
  });

  it("preserves deadline failures", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("expired", "TimeoutError"));
    expect(
      classifyRuntimeFailure(
        { code: "28P01" },
        "postgresql",
        controller.signal,
      ),
    ).toBe("timeout");
  });

  it("does not interpret another provider's native code", () => {
    expect(classifyRuntimeFailure({ code: "28P01" }, "mssql", signal)).toBe(
      "connection_failed",
    );
    expect(
      classifyRuntimeFailure({ number: 18456 }, "postgresql", signal),
    ).toBe("connection_failed");
  });

  it("handles cyclic driver errors without losing their classification", () => {
    const error: { code: string; cause?: unknown } = { code: "28P01" };
    error.cause = error;
    expect(classifyRuntimeFailure(error, "postgresql", signal)).toBe(
      "authentication_failed",
    );
  });
});
