# @sezzlee/db-core

Shared machinery for read-only, dialect-agnostic, database-backed MCP servers. `@sezzlee/mssql-mcp` and `@sezzlee/postgres-mcp` build on it.

It consumes `@sezzlee/mcp-core` (tool typing, response budget, error envelope, stdio server) and adds the relational layer on top: a connection pool, the cancellation rule, a value policy, catalogue introspection, and the four read-only tools.

This package is **not `@sezzlee/core`** — that one is the spec's HTTP catalog reference implementation.

## Usage

A product server plugs in a `Dialect<TConfig>` (everything one engine knows that another does not) and a `DriverAdapter<TConfig>` (the socket); `db-core` names no driver anywhere, not as a dependency, not as a peer. `createDbSource` binds a dialect, a connection profile and a driver adapter into the object every tool handler runs against, and `createDbMcpServer` builds the MCP server from it — this is exactly how `@sezzlee/mssql-mcp` is composed (`packages/servers/mssql-mcp/src/server.ts`):

```ts
import {
  connectionSecret,
  createDbMcpServer,
  createDbSource,
  type DbSource,
} from "@sezzlee/db-core";
import { mssqlDialect } from "./dialect/index.js";
import { createMssqlDriver } from "./driver/adapter.js";
import { asMssqlError, fail } from "./platform/errors.js";
import { limits } from "./platform/limits.js";
import { vocabulary } from "./platform/vocabulary.js";
import type { MssqlConfig } from "./platform/env.js";

export function createMssqlSource(config: MssqlConfig): DbSource<MssqlConfig> {
  return createDbSource(
    { dialect: mssqlDialect, vocabulary, fail, limits },
    {
      alias: config.database,
      secret: connectionSecret(config),
      display: {
        alias: config.database,
        engine: vocabulary.engineLabel,
        catalog: config.database,
        principal: config.user,
      },
    },
    createMssqlDriver(),
  );
}

export function createMssqlMcpServer(source: DbSource<MssqlConfig>) {
  return createDbMcpServer(
    { name: "sezzlee-mssql", version: "0.1.0" },
    source,
    asMssqlError,
  );
}
```

`createDbMcpServer`'s `close()` drains the connection pool before the underlying MCP server closes, so a terminated process does not leave open sockets holding the event loop.

## What it exports

| Module             | Contents                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `model/sql`        | The `SqlText` and `QuotedIdentifier` brands, `QuerySpec`, `QueryResult`                             |
| `model/value`      | `ColumnKind`, `ColumnDescriptor`, `NativeColumn`, `ValuePolicy`                                     |
| `model/catalog`    | `TableRef`, `TableEntry`, `KeyEntry`, `ServerFacts`, `IntrospectionScope`                           |
| `model/connection` | `ConnectionSecret`, `ConnectionProfile`, `DriverAdapter`, `DriverConnection`, `Lease`, `PoolLimits` |
| `model/dialect`    | `Dialect<TConfig>` — everything one engine knows that another does not                              |
| `values/encode`    | `encodeValue`, `encodeRow` — one policy from a cell to a JSON scalar                                |
| `pool`             | `createConnectionPool` (generation, lease, quarantine), `runCancellable`                            |
| `query`            | `createQueryRunner` — lease, run, classify the error, release                                       |
| `catalog`          | `introspect` — runs one introspection question; `createCatalogCache` — the catalogue snapshot       |
| `search`           | `tokenize`, `buildIndex`, `rank`, `likeMatches`, the catalogue cursor                               |
| `tools`            | `describe_connection`, `search_catalog`, `describe_table`, `run_query`                              |
| `source`           | `createDbSource` — binds a dialect, a profile and a driver into one object                          |
| `server`           | `createDbMcpServer` — including a `close()` that drains the pool                                    |

## Limits

`dbCoreLimits` (`src/limits.ts`) widens `mcpCoreLimits` with the relational defaults every source starts from; a server can override them through `DbEnvironment.limits`.

| Limit                 | Default | Notes                                                                                                                                                                                        |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRows`             | 1,000   | Hard cap on `run_query`'s `maxRows` argument.                                                                                                                                                |
| `defaultRows`         | 100     | `run_query`'s row cap when the caller does not set one.                                                                                                                                      |
| `maxColumns`          | 512     |                                                                                                                                                                                              |
| `maxKeys`             | 256     |                                                                                                                                                                                              |
| `maxTextChars`        | 4,096   | Per-cell text truncation.                                                                                                                                                                    |
| `maxBinaryBytes`      | 4,096   | Per-cell binary truncation.                                                                                                                                                                  |
| `maxListResults`      | 200     | Hard cap on `search_catalog`'s `maxResults`.                                                                                                                                                 |
| `defaultListResults`  | 50      |                                                                                                                                                                                              |
| `maxIndexObjects`     | 5,000   | Catalogue objects held in the in-memory search index.                                                                                                                                        |
| `maxIndexRows`        | 50,000  |                                                                                                                                                                                              |
| `maxDescriptionChars` | 160     |                                                                                                                                                                                              |
| `catalogIndexTtlMs`   | 15 min  | How long the catalogue index is cached before the next `search_catalog` call rebuilds it — measured at ~0.5 s to read and build, ~1 ms from cache, on a 614-object, 11,518-column catalogue. |
| `maxQueryTerms`       | 16      |                                                                                                                                                                                              |
| `maxExpansions`       | 32      |                                                                                                                                                                                              |
| `maxMatchReasons`     | 8       |                                                                                                                                                                                              |
| `queryTimeoutMs`      | 30,000  | Default query deadline; product servers may override it (see [Rules](#rules)).                                                                                                               |
| `maxConnections`      | 4       |                                                                                                                                                                                              |
| `maxQueueDepth`       | 32      |                                                                                                                                                                                              |
| `connectTimeoutMs`    | 15,000  |                                                                                                                                                                                              |
| `idleTimeoutMs`       | 60,000  |                                                                                                                                                                                              |
| `cancelSettleMs`      | 5,000   | How long a cancelled request may take to settle before its connection is destroyed instead of returned to the pool, rather than left to cross with the next query's result set.              |

## Rules

- **This package never produces SQL text and names no engine.** Relational vocabulary — catalog, schema, table, view, column, row, query, parameter, pool, connection — is ANSI and free to use. `TOP`, `OFFSET`/`FETCH`, `LIMIT`, `sys.`, `information_schema`, `nvarchar`, `mssql`, `tedious`, `pg` appearing inside `src/` is a defect.
- **No driver is named** — not a dependency, not a peer. The driver arrives through `DriverAdapter`, engine knowledge through `Dialect`; lint enforces this across the whole package.
- **`SqlText` is minted only by `sqlText()`, and that function belongs to the dialect layer.** Agent text becomes `SqlText` only through the `allow` arm of `Dialect.readOnlyGuard`, which makes "run the guard before the statement" a type rule rather than a convention. Consumer packages ban `sqlText` from their own tool layers with `importNames`.
- **Read-only has three layers, and the guard is the weakest.** The real guarantee is the database principal, and `run_query` verifies it: `Introspection.principal` measures the posture, the source caches it for five minutes, and `queryPermitted` refuses an administrator, a writable principal on a session that is not read-only, and a principal it could not measure. `Dialect.queryScope` brackets each query in the transaction an engine needs for a read-only session, and a connection whose transaction failed is quarantined. `readOnlyGuard` only turns a batch or a non-query into a legible error. Tool descriptions and `describe_connection` say so. The catalogue tools read metadata only and stay open to any principal by default, so an operator can browse a schema with an administrator login; a host that admits read-only logins alone passes `principalGate: "every_read"` to `createDbMcpServer`, and `search_catalog` and `describe_table` then refuse the same principals `run_query` does.
- **A cancelled request's connection does not return to the pool until it settles.** `runCancellable` holds the lease until `settled`, and quarantines the connection if `cancelSettleMs` is exceeded. `Promise.race([run(), abort()])` is exactly the bug this function exists to prevent.
- **`bigint` becomes a string; `decimal` is never repaired, only reported.** Measured: wide integers arrive from the driver as strings and stay intact, but a wide `decimal` arrives as binary64 with its low digits already gone (`123456789012345678.1234` → `123456789012345680`). Turning an already-corrupted number into a string would make it look precise, so a lossy column is reported with `lossy` instead. `LossKind` carries three values — `precision`, `timezone`, `representation` — and in all three `kind` keeps naming the real type; the flag only says the accompanying value is not as faithful as `kind` promises.
- **The catalogue index covers a prefix of catalogue order, and every object inside it is complete.** If a column read was cut short, the last object drops entirely along with its columns — a half-indexed table would otherwise answer a column search with silence while still appearing in other results, which reads as "that column does not exist." Partiality is declared on every response via `catalog.complete`, not only at setup.
- **Ranking is IDF, not BM25.** Term frequency does not distinguish anything across 1–4 token identifiers, so IDF alone is used; descriptions are also counted once per term, so `k1`/`b` are not needed anywhere.
- **Secrets are redacted at two layers.** `createDbSource` merges the core's redaction patterns with the dialect's and binds the result into `mcp-core`'s `ErrorContext.redact` seam, and the product's own error normalizer already produces redacted errors.

## Catalogue search

`search_catalog` reads the catalogue once, in two queries (objects, then columns), and turns it into an inverted index held in memory for `catalogIndexTtlMs`. An empty query is the paged listing, which is why there is no `list_tables`.

Measured on a 614-object, 11,518-column SQL Server catalogue, through the live MCP envelope:

|                                    |                                            |
| ---------------------------------- | ------------------------------------------ |
| first call, index build included   | 489 ms                                     |
| second call, from the cached index | 1 ms                                       |
| index                              | 2,156 terms, 25,068 postings, about 301 KB |

On the same catalogue with the column cap lowered to 4,000, the index held 211 whole objects and 3,993 columns; the boundary object kept all 17 of its columns, and a query for a name past the boundary returned no results with `complete: false` and a hint naming where coverage ends.

The `MS_Description` path was checked against a temporary table, because the sample catalogue carried no descriptions and a join returning zero rows cannot tell "correct, no data" from "broken." The deciding row was a column **without** a description coming back `null`: a predicate missing `minor_id` or with the wrong `class` would have spread the table's description onto every column.

Deliberately out of scope:

- **Column-level result rows.** On an 11,500-column catalogue one term would produce hundreds of column results that bury the tables, and ranking would compare two different units. Column matches already appear in `matched[]`.
- **A synonym or multilingual dictionary.** A separate problem; it can be added later without changing the index surface.
- **Row counts and statistics.** A different permission surface.
- **A persistent index.** Process lifetime is enough; persistence brings an invalidation problem.
- **Suffix and substring matching.** It would close the `tarih`/`FATURATARIH` gap, at a cost not yet measured.
- **Length decay for descriptions.** Added only if long descriptions are measured to suppress ranking.

## Development

```text
pnpm turbo run test --filter=@sezzlee/db-core
```
