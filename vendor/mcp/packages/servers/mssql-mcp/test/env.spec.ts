import { describe, expect, it } from "vitest";
import {
  readMssqlEnv,
  redactedConfig,
  requiredNames,
} from "../src/platform/env.js";
import { redact, fail } from "../src/platform/errors.js";
import { createMssqlSource } from "../src/server.js";

const complete = {
  SEZZLEE_MSSQL_SERVER: "db.internal",
  SEZZLEE_MSSQL_DATABASE: "Sales",
  SEZZLEE_MSSQL_USER: "mcp_reader",
  SEZZLEE_MSSQL_PASSWORD: "hunter2",
};

describe("readMssqlEnv", () => {
  it("names every variable it is missing", () => {
    const outcome = readMssqlEnv({});
    expect(outcome.kind).toBe("usage");
    if (outcome.kind === "usage") {
      expect([...outcome.missing]).toEqual([...requiredNames]);
    }
  });

  it("treats an empty string as missing", () => {
    const outcome = readMssqlEnv({ ...complete, SEZZLEE_MSSQL_PASSWORD: "" });
    expect(outcome.kind).toBe("usage");
  });

  it("fills the defaults when only the required four are set", () => {
    const outcome = readMssqlEnv(complete);
    expect(outcome.kind).toBe("config");
    if (outcome.kind === "config") {
      expect(outcome.config).toMatchObject({
        server: "db.internal",
        port: 1433,
        encrypt: true,
        trustServerCertificate: false,
        connectTimeoutMs: 15_000,
        queryTimeoutMs: 30_000,
      });
    }
  });

  it("accepts both spellings of a flag", () => {
    for (const [raw, expected] of [
      ["true", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ] as const) {
      const outcome = readMssqlEnv({ ...complete, SEZZLEE_MSSQL_ENCRYPT: raw });
      expect(outcome.kind).toBe("config");
      if (outcome.kind === "config") {
        expect(outcome.config.encrypt).toBe(expected);
      }
    }
  });

  it("refuses a flag it cannot read rather than guessing", () => {
    expect(
      readMssqlEnv({ ...complete, SEZZLEE_MSSQL_ENCRYPT: "yes" }).kind,
    ).toBe("invalid");
  });

  it("refuses a port that is not a positive integer", () => {
    for (const port of ["0", "-1", "1.5", "abc"]) {
      expect(readMssqlEnv({ ...complete, SEZZLEE_MSSQL_PORT: port }).kind).toBe(
        "invalid",
      );
    }
  });
});

describe("redactedConfig", () => {
  it("carries no password, by shape", () => {
    const outcome = readMssqlEnv(complete);
    expect(outcome.kind).toBe("config");
    if (outcome.kind === "config") {
      const shown = redactedConfig(outcome.config);
      expect(JSON.stringify(shown)).not.toContain("hunter2");
      expect(Object.keys(shown)).not.toContain("password");
    }
  });
});

describe("the mssql redactor", () => {
  it("strips the ODBC keyword forms the core does not know", () => {
    const text = redact(
      "Data Source=10.0.0.5;Initial Catalog=Sales;User Id=sa;Password=hunter2",
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("sa;");
    expect(text).toContain("Password=[redacted]");
  });

  it("strips a url form too", () => {
    expect(redact("mssql://sa:hunter2@10.0.0.5:1433")).not.toContain("hunter2");
  });

  it("is applied when the error is built, not when it is rendered", () => {
    const error = fail(
      "connection_failed",
      "login failed for Password=hunter2",
    );
    expect(error.message).not.toContain("hunter2");
  });

  it("leaves an ordinary message alone", () => {
    expect(redact("Invalid object name 'dbo.Orders'.")).toBe(
      "Invalid object name 'dbo.Orders'.",
    );
  });
});

describe("createMssqlSource", () => {
  it("enforces the timeouts the environment sets, not the defaults", () => {
    const outcome = readMssqlEnv({
      ...complete,
      SEZZLEE_MSSQL_QUERY_TIMEOUT_MS: "5000",
      SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS: "2000",
    });
    if (outcome.kind !== "config") throw new Error(outcome.kind);
    const source = createMssqlSource(outcome.config);
    expect(source.limits.queryTimeoutMs).toBe(5_000);
    expect(source.limits.connectTimeoutMs).toBe(2_000);
  });
});
