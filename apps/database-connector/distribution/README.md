# Sezzlee database connector

The connector lets Sezzlee query SQL Server and PostgreSQL databases that live inside your network. It runs on a machine that can reach your database servers and keeps an outbound HTTPS connection to Sezzlee, so you open no inbound port. It runs read-only queries for the people in your Sezzlee workspace, under a database login you choose, against servers you allow on that machine.

This repository holds the connector's source and builds every release. The code is developed in Sezzlee's private repository and synced here; [`SOURCE.json`](SOURCE.json) names the commit each sync came from. The database servers under `vendor/mcp` come from the public [sezzlee/mcp](https://github.com/sezzlee/mcp) repository.

## How it works

- **Outbound only.** The connector long-polls Sezzlee over HTTPS for queries and posts results back. It never listens on a port.
- **Your passwords stay sealed.** When you enter a database password in Sezzlee, your browser seals it to this connector's key before it leaves your browser. Sezzlee stores only the sealed form; only this connector can open it, in memory, while a query runs. The seal names the server, the port and the login, so it cannot be replayed against another target.
- **You decide which servers it reaches.** The connector dials only the `host:port` entries in its local allowlist. Sezzlee cannot change that list; a query for any other server is refused before its password is opened. The connector resolves each host once and pins the connection to that address.
- **Read-only.** Every query runs through read-only checks, and the connector refuses a login that can write.
- **Secrets at rest.** The device token and the connector's private key are sealed in a state file under a key kept in the macOS Keychain, by Windows DPAPI or in the Linux Secret Service. Where no secret store is available (a Linux server without Secret Service, a container) the key sits in a separate owner-only file.
- **You can check what it says it does.** The fingerprint you confirm in Sezzlee before entering the first password is the connector's own key; a key that later differs is refused by your browser.

## Install

Download the archive for your platform from [Releases](https://github.com/sezzlee/database-connector/releases). Each archive holds one executable with Node built in; nothing else needs to be installed.

| Platform              | Archive                                                    |
| --------------------- | ---------------------------------------------------------- |
| Windows x64           | `sezzlee-database-connector-<version>-windows-amd64.zip`   |
| Linux x64             | `sezzlee-database-connector-<version>-linux-amd64.tar.gz`  |
| Linux arm64           | `sezzlee-database-connector-<version>-linux-arm64.tar.gz`  |
| macOS (Apple silicon) | `sezzlee-database-connector-<version>-darwin-arm64.tar.gz` |
| macOS (Intel)         | `sezzlee-database-connector-<version>-darwin-amd64.tar.gz` |
| Docker                | `ghcr.io/sezzlee/database-connector:<version>`             |

### Verify the download

Every archive, every executable inside it and the container image carry a build provenance attestation from this repository's release workflow. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify sezzlee-database-connector-<version>-linux-amd64.tar.gz --repo sezzlee/database-connector
gh attestation verify oci://ghcr.io/sezzlee/database-connector:<version> --repo sezzlee/database-connector
```

Without it, compare the archive against `SHA256SUMS` from the same release:

```sh
sha256sum --check --ignore-missing SHA256SUMS
```

Each release also publishes an SPDX software bill of materials (`sezzlee-database-connector.spdx.json`).

The macOS executables are signed with a Developer ID and notarized by Apple. Apple cannot staple the notarization ticket to a single executable, so Gatekeeper checks it online the first time the file runs; on a machine without internet access, verify the attestation instead. The Windows executables are not code-signed yet, so Windows SmartScreen warns on first launch; the attestation and `SHA256SUMS` still prove where the file came from.

## Pair

1. In Sezzlee, open **Integrations → Database connectors** and choose **Pair a connector**. Copy the single-use pairing code; it expires in 10 minutes.
2. On the machine that can reach your database, run the command Sezzlee shows:

   ```sh
   sezzlee-database-connector pair --api https://<your Sezzlee address>/api
   ```

3. Paste the pairing code when asked. It is not shown on screen and never goes on the command line.
4. Note the confirmation code the connector prints. Sezzlee asks you to type it before you enter the first database password.
5. Enter the first database server the connector may reach (`host:port`), or press Enter to add servers later.

## Allow database servers

```sh
sezzlee-database-connector allow add sql01.corp.local:1433
sezzlee-database-connector allow add "[fd00::5]:5432"
sezzlee-database-connector allow list
sezzlee-database-connector allow remove sql01.corp.local:1433
```

The list starts empty and changes apply to the next query without a restart.

## Run

To try it in a terminal:

```sh
sezzlee-database-connector run
```

To run it as a service, which pairs it first when needed:

- **Windows**, from an elevated prompt, with `sezzlee-database-connector-service.exe` from the same archive next to the executable:

  ```powershell
  .\sezzlee-database-connector.exe service install --api https://<your Sezzlee address>/api
  ```

  The service `SezzleeDatabaseConnector` runs under the virtual account `NT SERVICE\SezzleeDatabaseConnector` and keeps its state in `%ProgramData%\Sezzlee\DatabaseConnector`, readable only by that account, SYSTEM and Administrators.

- **Linux**, with systemd:

  ```sh
  sudo ./sezzlee-database-connector service install --api https://<your Sezzlee address>/api
  ```

  The unit `sezzlee-database-connector.service` runs as the system user `sezzlee-connector` with no capabilities and write access only to `/var/lib/sezzlee-database-connector`.

- **macOS**: `sezzlee-database-connector service install --api …` installs a launch agent that runs while you are logged in.

On a service, prefix the allowlist and fingerprint commands with `service` (`sudo` on Linux, an elevated prompt on Windows), for example `sezzlee-database-connector service allow add sql01.corp.local:1433`. `service uninstall` removes the service and keeps its state.

### Docker

[`compose.yaml`](compose.yaml) runs the image read-only, with every capability dropped and `no-new-privileges`:

```sh
export CONNECTOR_VERSION=<version>
docker compose run --rm connector pair --api https://<your Sezzlee address>/api
docker compose run --rm connector allow add sql01.corp.local:1433
docker compose up -d
```

The image holds only the executable on a distroless base, has no shell and runs as UID 65532.

## Move to another machine

To replace the machine without entering the database passwords again:

1. In Sezzlee, choose **Move to another machine** on the connector and copy the single-use move code.
2. On the old machine: `sezzlee-database-connector move export connector-move.json`. It writes the connector's identity, key and allowlist to a file sealed with the export code it prints.
3. Copy the file to the new machine and run `sezzlee-database-connector move import connector-move.json`. Enter the export code and the move code when asked.

The new machine must not hold a connector yet. The old machine stops as soon as the import succeeds. Delete the move file afterwards. If the old machine is lost, pair a new connector and enter the passwords again.

## Build from source

Requires Node 24 and pnpm (the version in `package.json`):

```sh
pnpm install --frozen-lockfile
pnpm turbo run build check-types lint test
pnpm sea
```

`pnpm sea` writes `apps/database-connector/dist/sea/sezzlee-database-connector` for the current platform.

## Security

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). The servers under `vendor/mcp` are MIT ([vendor/mcp/LICENSE](vendor/mcp/LICENSE)).
