import type { OxlintOverride } from "oxlint";

const sezzleePattern = {
  group: ["@sezzlee/*"],
  message:
    "The chat product does not import sezzlee product packages. Shared schemas live in @chat/contracts.",
};

/**
 * Guard: blocks the chat product line from importing sezzlee product packages.
 * `@sezzlee/sdk-nestjs` is on zod 3 while `@chat/contracts` is on zod 4; two zod
 * majors in one process make `instanceof ZodError` and schema identity fail
 * silently. Scoped to `src/**` so `oxlint.config.ts` and `tsconfig.json` can
 * still consume the shared toolchain packages.
 */
export const chat: OxlintOverride[] = [
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [sezzleePattern] }],
    },
  },
];

/**
 * Guard: the two rules that keep the contract layer the single owner of every
 * schema, for `@chat/api` and `@chat/web`.
 *
 * A `zod` value import is refused because a schema declared next to the code
 * that consumes it drifts from the other side of the wire within one release;
 * type-only imports stay legal so a pipe can still name `ZodType`. A bare
 * `@chat/contracts` import is refused because the package publishes leaf
 * subpaths only: the barrel would pull every domain into the module graph,
 * which `@chat/api` pays for at runtime since it ships unbundled.
 */
export const chatApp: OxlintOverride[] = [
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@chat/contracts",
              message:
                "Import the leaf module instead, e.g. @chat/contracts/chat/send-message.",
            },
          ],
          patterns: [
            sezzleePattern,
            {
              group: ["zod", "zod/*"],
              allowTypeImports: true,
              message:
                "Schemas live in @chat/contracts. Import the schema from its leaf module; only type-only zod imports are allowed here.",
            },
          ],
        },
      ],
    },
  },
];

/**
 * Guard: inside the module that talks to registrant-supplied addresses, the only
 * way out is the guarded transport. `fetch` resolves a host and opens the socket
 * in one step with no hook between them, so a single bare call reaches the
 * deployment's own private network on request — the SSRF the guarded lookup
 * exists to refuse. `guarded-http.ts` is exempt because it is what wraps
 * `node:https`.
 *
 * The rule covers the directories named here and nothing else: an outbound
 * client added elsewhere is outside it until its directory is added.
 */
const socketPatterns = [
  {
    group: ["node:http", "node:https", "node:net", "node:dns"],
    message:
      "Only guarded-http.ts opens sockets here; use guardedRequest from ./guarded-http.ts.",
  },
];

const undiciPath = {
  name: "undici",
  message:
    "Use guardedRequest from ./guarded-http.ts rather than a second http client.",
};

const oauthPath = {
  name: "oauth4webapi",
  message:
    "Import the wrappers from ./oauth-client.ts: they bind the guarded transport as customFetch.",
};

const fetchGlobal = {
  name: "fetch",
  message:
    "Use guardedRequest from ./guarded-http.ts: it validates the resolved address inside the connector's lookup.",
};

/**
 * Guard: inside the module that talks to registrant-supplied addresses, the only
 * way out is the guarded transport. `fetch` resolves a host and opens the socket
 * in one step with no hook between them, so a single bare call reaches the
 * deployment's own private network on request — the SSRF the guarded lookup
 * exists to refuse.
 *
 * `oauth4webapi` is restricted for the same reason and a sharper one: every one
 * of its requests reads `(options[customFetch] || fetch)`, so a call site that
 * omits the option falls back to the bare global silently, with no error and no
 * sign in the response. `oauth-client.ts` is the one file that may name the
 * library, and it binds the transport on every call.
 *
 * `guarded-http.ts` is exempt from the socket rules because it is what wraps
 * `node:https`. The rule covers the directories named here and nothing else: an
 * outbound client added elsewhere is outside it until its directory is added.
 */
export const chatUntrustedHttp: OxlintOverride[] = [
  {
    files: ["src/connections/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", fetchGlobal],
      "no-restricted-imports": [
        "error",
        { paths: [undiciPath, oauthPath], patterns: socketPatterns },
      ],
    },
  },
  {
    files: ["src/connections/oauth-client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [undiciPath], patterns: socketPatterns },
      ],
    },
  },
  {
    files: ["src/connections/guarded-http.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-imports": "off",
    },
  },
];

const listeners: readonly (readonly [string, readonly string[]])[] = [
  ["http", ["createServer", "Server"]],
  ["https", ["createServer", "Server"]],
  ["http2", ["createServer", "createSecureServer"]],
  ["net", ["createServer", "Server"]],
  ["tls", ["createServer", "Server"]],
  ["dgram", ["createSocket"]],
];

/**
 * Guard: the customer opens no inbound port for the database connector, and
 * the security document cites this rule as the proof. The executor and the
 * connector only dial out, so no module they run may create a listening
 * socket. The default import is refused too, or `http.createServer` would slip
 * past the named-import check.
 */
export const outboundOnly: OxlintOverride[] = [
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: listeners.flatMap(([module, names]) =>
            [module, `node:${module}`].map((name) => ({
              name,
              importNames: ["default", ...names],
              message:
                "The database connector only dials out; customers open no inbound port (docs/database-connector/overview/security.md).",
            })),
          ),
        },
      ],
    },
  },
];
