# @sezzlee/mssql-mcp

Read-only MCP server for Microsoft SQL Server. It builds on `@sezzlee/db-core` and names no other `@sezzlee/*` package.

## Quick start

The connection comes from the environment, not from a tool argument, so a client only needs the four required variables:

```text
SEZZLEE_MSSQL_SERVER=10.0.0.5 \
SEZZLEE_MSSQL_DATABASE=Sales \
SEZZLEE_MSSQL_USER=mcp_reader \
SEZZLEE_MSSQL_PASSWORD=... \
npx -y @sezzlee/mssql-mcp
```

See [Configuration](#configuration) for the full variable list and defaults.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe_connection` | Reports which database this server is connected to, what the connection may do, and the limits every other tool is bound by. Takes no arguments and never returns credentials.                                                                                                                                                  |
| `search_catalog`      | Finds tables and views by concept rather than exact name: the query is matched against schema, object and column names, and against whatever descriptions the catalogue carries. Leave `query` empty to page through the catalogue instead. Start here — the names it returns are what `describe_table` and `run_query` accept. |
| `describe_table`      | Reports one table's columns with their types and nullability, plus its primary, unique and foreign keys. Read this before writing a query against the table.                                                                                                                                                                    |
| `run_query`           | Runs one read-only SQL statement and returns its rows. Writes are refused. The response is capped and there is no cursor, so a large result is walked with your own ordering and paging clause; a truncated response names which clause this engine uses.                                                                       |

## Configuration

The connection is read from the environment when the process starts. **The agent cannot supply connection details** — no tool argument carries them.

```text
SEZZLEE_MSSQL_SERVER=10.0.0.5
SEZZLEE_MSSQL_DATABASE=Sales
SEZZLEE_MSSQL_USER=mcp_reader
SEZZLEE_MSSQL_PASSWORD=...
SEZZLEE_MSSQL_PORT=1433                       # default
SEZZLEE_MSSQL_ENCRYPT=true                    # default
SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE=false  # default
SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS=15000        # default
SEZZLEE_MSSQL_QUERY_TIMEOUT_MS=30000          # default

npx -y @sezzlee/mssql-mcp
```

| Variable                                 | Default         | Meaning                                              |
| ---------------------------------------- | --------------- | ---------------------------------------------------- |
| `SEZZLEE_MSSQL_SERVER`                   | none — required | Server host.                                         |
| `SEZZLEE_MSSQL_DATABASE`                 | none — required | Database name.                                       |
| `SEZZLEE_MSSQL_USER`                     | none — required | Login used to connect.                               |
| `SEZZLEE_MSSQL_PASSWORD`                 | none — required | Password for that login.                             |
| `SEZZLEE_MSSQL_PORT`                     | `1433`          | TCP port.                                            |
| `SEZZLEE_MSSQL_ENCRYPT`                  | `true`          | Whether the connection is encrypted.                 |
| `SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE` | `false`         | Whether an untrusted server certificate is accepted. |
| `SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS`       | `15000`         | Connection timeout.                                  |
| `SEZZLEE_MSSQL_QUERY_TIMEOUT_MS`         | `30000`         | Query deadline (see [Rules](#rules)).                |

The first four variables are required. Parsing is eager and fatal; **connecting is lazy** — a dead database server does not stop the process from starting and answering `tools/list`.

## Read-only posture

Three layers, and **the weakest one lives inside this package**:

1. **The database principal — the real guarantee, and verified.** Connect with a user that is `db_datareader` and nothing else. `run_query` measures the principal before it runs a statement and refuses every query while it holds a server role or a server permission such as `CONTROL SERVER` or `ADMINISTER BULK OPERATIONS` (not measured on Azure SQL Database, which has none), `db_owner`, `db_securityadmin`, `db_accessadmin`, `db_datawriter` or `db_ddladmin`, or any database or object permission to insert, update, delete, alter or create, including `UPDATE` or `ALTER` on a sequence, since `NEXT VALUE FOR` advances it even when the transaction rolls back. `describe_connection` reports the result as `principalPosture`.
2. **The transaction.** MSSQL has no read-only session or transaction. `ApplicationIntent=ReadOnly` only routes into a readable secondary inside an availability group; on a standalone instance it guarantees nothing, and `describe_connection` reports `sessionIntent: "none"`. Instead every query, catalogue questions included, runs inside `BEGIN TRANSACTION` and is always rolled back, so a write that slipped past layer 3 is undone in this database. Effects outside the transaction (sequence and identity values, remote calls) are not, which is why layer 1 still refuses a writable principal. Statements without parameters are sent as a plain batch, not through `sp_executesql`, because SQL Server fails a remote call that returns with a different transaction count and reverts the SET options it changed.
3. **The statement guard — a legible error, nothing more.** `readOnlyGuard` masks comments and string literals, then checks that the first word is `SELECT` or `WITH`, that no `;` separates a second statement, and that no reserved statement keyword (`DELETE`, `EXEC`, `INTO`, `WAITFOR`, `OPENQUERY`, `OPENROWSET`, …) or system procedure appears. T-SQL needs no `;` between statements, so the keyword check is what keeps the text to one statement, and the rowset functions are refused because they run under another server's login where layer 1 cannot see. It does not replace layer 1 for writes in this database.

## Rules

- **`src` is three lint-enforced layers over three root entrypoints.** `platform/` (the db-core and Node boundary), `dialect/` (the only folder that writes SQL), `driver/` (the only folder that names `mssql`); `cli.ts`, `server.ts` and `index.ts` stay at the root as the single composition root.
- **`sqlText` and `quotedIdentifier` are callable only inside `dialect/`**, banned elsewhere by `importNames`. Agent text becomes `SqlText` only through the `allow` arm of `readOnlyGuard`.
- **`process.env` is read only in `cli.ts`**, each variable accessed by name — `turbo/no-undeclared-env-vars` forces every one of them into `turbo.json`'s `passThroughEnv`.
- **The query deadline is never left to `request.timeout`.** Measured: that field does not interrupt a running statement (`request.timeout = 800` did not stop a 10 s `waitfor delay`). The deadline is a timer plus an explicit `cancel()`.
- **The type table's source of truth is the normative list, not what one database happens to contain.** `dialect/types.ts` covers the full T-SQL type list and answers to both namespaces at once (`sys.types.name` and the driver's result-set name). The reasoning behind each mapping, and the two types left `unknown` on purpose (`sql_variant`, whose shape changes per row, and `vector`, a SQL Server 2025 type whose `tedious@18` shape is unmeasured), are documented in `dialect/types.ts`'s own guard comments and in `test/dialect.spec.ts`.
- **Every logical connection is its own driver pool with `max: 1`.** Pooling is owned by `db-core`; a second pool underneath it would let two calls share the same socket behind its back — the exact opposite of what the cancellation rule depends on.

## Development

```text
pnpm turbo run test --filter=@sezzlee/mssql-mcp
```

These are pure function tests; no database is needed.

Catalogue SQL cannot be verified with a fake: a snapshot proves the text has not changed, not that the joins are correct. `test/live.spec.ts` exists for that and runs against a real server:

```text
SEZZLEE_MSSQL_LIVE=1 SEZZLEE_MSSQL_SERVER=... pnpm turbo run test --filter=@sezzlee/mssql-mcp
```

Without `SEZZLEE_MSSQL_LIVE` the live suite is skipped, so CI needs no database. **Do not run this suite against production** — it exercises query cancellation and dropped connections.

Every driver fact this server relies on was measured on SQL Server 15.0.2000.5 (2019 Developer Edition) with `mssql@11.0.2` → `tedious@18.6.2`, which is why `mssql` is pinned exactly. `tedious` is still resolved by `mssql`'s own range, so re-run the live suite after a lockfile change that moves it.
