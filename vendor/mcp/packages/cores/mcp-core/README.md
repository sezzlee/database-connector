# @sezzlee/mcp-core

Source-agnostic machinery for read-only MCP servers: tool typing, the response budget, the error
envelope, the cursor codec and a stdio server. `@sezzlee/file-core` (file sources) and
`@sezzlee/db-core` (SQL sources) are both built on top of it.

This package is **not `@sezzlee/core`** and does not depend on it in either direction.
`@sezzlee/core` is the spec's HTTP catalog reference implementation; this package is the shared
machinery behind local source servers. It knows nothing about what a source is — a file, a
database, anything else. All it knows is the path from a tool's input schema to its response
envelope.

## Usage

A consumer declares its tools as a `satisfies ToolDefinitions` catalogue built with `readOnly`
(or `ownOutput` for a writing catalogue, see below), wraps each handler with `guard()` to get a
`GuardedHandler`, and passes the catalogue plus the `HandlersOf<D>` map to
`createMcpSourceServer` (or `createMcpOutputServer`) together with a `ServerIdentity`.
`serveMcpSourceStdio` wires the result to stdio and process signals. `guard()` is the only
function that produces a `GuardedHandler`, so a hand-written handler cannot be registered — this
is what makes the `mcpCoreLimits.maxPayloadBytes` response budget unbypassable.

## API

| Module       | Exports                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`      | `readOnly`, `ownOutput`, `json`, `toToolError`, `guard`, `HandlersOf<D>`, `ToolCatalog` and the tool type machinery                                                                         |
| `server`     | `createMcpSourceServer` (read-only), `createMcpOutputServer` (catalogue with an output-writing tool), `serveMcpSourceStdio` — registers tools from the definitions, wires stdio and signals |
| `payload`    | `measureJson`, `createPageBudget`, `clampJsonField` — the response budget                                                                                                                   |
| `errors`     | `McpSourceError`, `SourceErrorCode`, `ErrorFactory`, the `internal_error` policy, injected redaction                                                                                        |
| `cursor`     | The `Fingerprint` brand, `Cursor<TPosition>`, the base64url codec, `isFresh`                                                                                                                |
| `limits`     | `mcpCoreLimits` — `maxPayloadBytes`, `maxStringChars`, `catalogTtlMs`                                                                                                                       |
| `unicode`    | `fold`, `canonical`, `asciiLower`, `asciiUpper`, `truncateWellFormed`, `truncateUtf8`                                                                                                       |
| `vocabulary` | `Vocabulary<TToolName>` — injection point for user-facing names                                                                                                                             |

## Rules

- **No source-specific vocabulary.** A string literal such as `"file"`, `"path"`, `"workbook"`,
  `"table"` or `"query"` inside this package is a defect; user-facing names arrive through the
  injected `Vocabulary`.
- **Redaction is injected, never chosen here.** `ErrorContext.redact` strips whatever a source
  must never disclose — a file root, a connection secret. The core cannot know what is sensitive,
  so it does not decide.
- **Where an unexpected error is logged is injected too.** `GuardContext.report` receives a thrown
  error no normalizer classified. Absent, `guard()` writes its stack to stderr, which a standalone
  server's operator reads; a host that must not log driver detail (a hostname, a login, a value)
  passes its own reporter.
- **Error instances come from the injected `ErrorFactory`.** The package never calls
  `new McpSourceError(...)` in its own code paths, which keeps a consumer's own error class and
  `instanceof` checks intact.
- **`guard()` is the only producer of a `GuardedHandler`**, and `HandlersOf<D>` accepts nothing
  else. This is what makes the response budget unbypassable: a hand-written handler cannot be
  registered.
- **A tool that writes output is registered only through `createMcpOutputServer`.**
  `ToolDefinitions` and `createMcpSourceServer` stay read-only; `ownOutput`,
  `OwnOutputToolDefinition`, `ToolCatalog` and `createMcpOutputServer` are never re-exported by
  `file-core` or `db-core`. The rules for writing to disk (one folder, `wx`, the server picks the
  name) belong to the consumer.
- **Every input schema is closed, and every argument failure is an envelope.** The SDK is handed a
  schema that publishes the tool's schema with `additionalProperties: false` but validates nothing;
  the strict parse runs in `buildServer`, before the handler, and a failure becomes
  `invalid_argument` whose recovery lists the accepted arguments. Left to the SDK, zod's default
  object drops an unknown key — a misspelt `caseSensitiv` then succeeds with the default — and a
  wrong type is answered with plain text that carries no `error` code.
- **`zod` and `@modelcontextprotocol/server` are peer dependencies.** Two resolved copies would
  break `z.infer` type identity, and the SDK's schema introspection does an `instanceof` check.
- **The `Fingerprint` brand is declared only here.** A second `unique symbol` declaration is not
  the same brand, even with the same name.

## Design decisions

**Why a separate package.** `file-core` held this machinery before a SQL server needed it. Three
options were weighed:

- _Copy it into `db-core`._ About 430 lines, so a fix to the response budget would have to land
  twice. That is a fork, not a shared primitive.
- _Depend on `file-core`._ `ErrorFactory` is contravariant in its code parameter, so `DbErrorCode`
  would have had to widen to carry `path_outside_root` and `file_too_large`; `Vocabulary` would
  have forced `rootLabel` and `readableLabel` on a SQL server; and a pure-JS database server would
  have shipped `file-core-native`'s C++ prebuilds.
- _Rename `file-core`._ The file layer (sandbox, listing, document cache, native access) is real
  and large; leaving it inside the core would still ship the prebuilds to every consumer.

**Why a dependency, not a peer.** `guard()` classifies with `instanceof McpSourceError` and every
product error class extends it. Two resolved copies would break that check silently — the same
trap as two zod majors. `zod` and the MCP SDK stay peers for the same reason in the other
direction: the consumer owns them.

**Why `GuardContext.fail` is `ErrorFactory<"resource_limit">`.** `guard()` only ever fails with
that code. Narrowing it keeps every existing caller compiling (contravariance) and never forces a
consumer's error union to carry the core's codes.

**Why the own-output tool type looks the way it does.** A client may approve a tool by its
annotations alone — Codex does with `default_tools_approval_mode = "auto"` — so a writing tool
that claimed `readOnlyHint: true` would be an unapproved write. Rejected on the way:

- _Widening `ToolDefinitions`._ Every read-only server's `satisfies ToolDefinitions` would
  silently start accepting a writing tool.
- _Widening `createMcpSourceServer`._ `file-core` re-exports it as `createFileSourceServer`, so
  the writing type would leak into every file server.
- _A `unique symbol` brand on the annotations._ Annotations travel as JSON and the symbol key is
  dropped; a plain object would still match structurally.
- _Putting the writer here._ The core has no runtime dependencies and carries no source
  vocabulary; the writer lives with the consumer that makes the promise.

A tool that changes or deletes existing state fits no catalogue type, on purpose.

## Development

```bash
pnpm turbo run build check-types lint --filter=@sezzlee/mcp-core
pnpm turbo run test --filter=@sezzlee/mcp-core
```

Always build through Turbo, never `pnpm --filter @sezzlee/mcp-core run build` on its own, so
generated dependencies stay in sync.
