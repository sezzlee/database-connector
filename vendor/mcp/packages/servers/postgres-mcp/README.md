# @sezzlee/postgres-mcp

Read-only PostgreSQL MCP server. Uses the shared database core for four tools: `describe_connection`, `search_catalog`, `describe_table`, and `run_query`.

Use a role created for this server alone, granted `SELECT` on the objects the agent may read and nothing else; never one another application signs in with. Qualify application tables with their schema.

## Read-only guarantees

Every query, catalogue questions included, runs in its own `START TRANSACTION READ ONLY` with transaction-local statement and lock deadlines, `pg_catalog` as its search path and `standard_conforming_strings` on, and always ends in `ROLLBACK`, including after a successful read. A connection whose transaction failed is closed rather than reused. `run_query` measures the principal first and refuses every query while it is, or is a member of, a role that is a superuser, can create roles or replicate, or can read or write server files, run server programs or signal other backends.

These are three separate guarantees, held to different degrees:

- **Data is not changed.** Held by the read-only transaction, which the server enforces for every principal, superusers included: writes, `nextval`, large-object writes and DDL fail. A function the database defines can still reach outside it, for example through `dblink` or another connection it opens itself.
- **Session state does not outlive the query.** Held by the rollback, which undoes settings a statement changes with `set_config(..., false)` and drops any `NOTIFY` it queued. Session advisory locks survive a rollback, so the guard refuses the functions that take them and the scope releases any left before rolling back. No `SET` is ever issued at session level, so nothing reaches another client through a transaction pooler.
- **Other sessions are not disturbed.** Held only in part. A role may cancel or terminate other sessions of the same role without `pg_signal_backend`, and functions are executable by `PUBLIC` by default. The statement guard refuses the built-in functions that signal other sessions, take session locks or run SQL text it never sees (`query_to_xml`, `cursor_to_xml`, `ts_stat`, `ts_rewrite`, `dblink`, and their siblings), and refuses `U&"…"` identifiers rather than decode them. That list is an added layer over a statement, not a boundary: it does not see what a view or a database-defined function calls. A dedicated role narrows what a missed call can reach to this server's own sessions; it does not remove it.

The statement guard otherwise refuses only a batch, a statement that does not begin with `SELECT` or `WITH`, and an unterminated literal or comment, and says which.

## CLI

Run `sezzlee-postgres` over MCP stdio. Required environment variables:

| Variable                    | Meaning                           |
| --------------------------- | --------------------------------- |
| `SEZZLEE_POSTGRES_SERVER`   | PostgreSQL hostname or IP address |
| `SEZZLEE_POSTGRES_DATABASE` | Exact database name               |
| `SEZZLEE_POSTGRES_USER`     | Reader principal                  |
| `SEZZLEE_POSTGRES_PASSWORD` | Password                          |

Optional variables: `SEZZLEE_POSTGRES_PORT` (5432), `SEZZLEE_POSTGRES_SSL_MODE` (`verify-full`), `SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS` (30000), and `SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS` (30000). SSL modes are `disable`, `require` (encryption without certificate verification), and `verify-full` (verified certificate chain and original hostname). Configuration parsing is fatal; connection opening is lazy, allowing tool discovery while the database is unavailable.

## Embedding

`createPostgresSource(config, options?)` returns `DbSource<PostgresConfig>`; `createPostgresMcpServer(source)` exposes the shared tools. Configuration fields: `server`, `port`, `database`, `user`, `password`, `sslMode`, `caCertificate`, `connectTimeoutMs`, `queryTimeoutMs`. `caCertificate` is optional PEM text holding one or more certificate authority certificates; when set, the server certificate must chain to one of them instead of the Node.js default trust store, which is how a server signed by a private authority (AWS RDS, Google Cloud SQL, a self-hosted CA) passes `verify-full`.

`options.host` overrides the physical dial address, allowing a caller to pin an approved IP. `options.serverName` retains the original certificate hostname independently of that address. Verified TLS uses this original identity for certificate checks; IP identities omit SNI. Callers requiring verified TLS must choose `verify-full`. Test seams `clientFactory` and `cursorFactory` accept structural driver adapters; production defaults use `pg` and `pg-cursor`.

Rows arrive through server cursors in batches of at most 128. One lookahead row proves truncation; the portal is closed and PostgreSQL acknowledges readiness before the connection returns to the shared pool. Caller cancellation and deadlines close the physical connection, which the core quarantines before reuse. Numeric/bigint and temporal text parsers preserve decimal precision, microseconds, and timestamp offsets. Unknown driver type OIDs remain explicitly unknown.

Catalog introspection includes readable tables, partitions, foreign tables, views/materialized views, column descriptions, table descriptions, primary/unique/foreign constraints, and server identity. Names are matched exactly; catalog ordering uses the deterministic `C` collation. Unique indexes that are not constraints are not reported as keys.

## Verification

`pnpm turbo run build check-types lint test --filter=@sezzlee/postgres-mcp` verifies unit and fake-driver lifecycle checks. No live database is needed. Live PostgreSQL protocol/catalog verification requires an existing authorized endpoint and has not been performed for this package.
