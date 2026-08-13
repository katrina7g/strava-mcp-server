# Strava MCP Server

A local MCP server for exploring a Strava data export. This project
will enable an MCP client to query training data, without connecting to a service.

## Scope

This repository contains a local, read-only MCP server for a Strava data export. It validates an archive and stores its validation history in a separate local SQLite database; activity import and training queries follow in later phases.

This server is:

- **Local-only.** It does not upload an export, use cloud storage, or connect to the Strava API.
- **Read-only.** It will not create, edit, delete, upload, or otherwise change Strava data.
- **Privacy-first.** Precise routes, privacy zones, account identifiers, and
  other sensitive data will be withheld by default.

It does not support OAuth, authentication, multi-user access, hosted
deployment, webhooks, or automatic Strava synchronization.

## Prerequisites

- Node.js 18 or newer
- A local Strava export when activity import is implemented

## Install and verify

```bash
git clone https://github.com/katrina7g/strava-mcp-server.git
cd strava-mcp-server
npm install

npm run typecheck
npm test
npm run build
```

The available scripts are:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript server in watch mode. |
| `npm run build` | Compile `src/` to `dist/`. |
| `npm run start` | Run the compiled stdio server. |
| `npm run typecheck` | Typecheck production and test TypeScript. |
| `npm test` | Run the test suite once. |
| `npm run test:watch` | Run tests in watch mode. |

`npm run dev` and `npm run start` intentionally appear idle when run directly:
an MCP server waits for a client connection over standard input.

## Test with MCP Inspector

First build the server and configure its local paths:

```bash
export STRAVA_EXPORT_DIR="/absolute/path/to/strava-export"
export STRAVA_MCP_DATA_DIR="$HOME/.strava-mcp-server"

npm run build
npx --yes @modelcontextprotocol/inspector
```

Open the Inspector URL printed by the terminal. Add a server with these values:

| Field | Value |
| --- | --- |
| Transport | `STDIO` |
| Command | `node` |
| Arguments | `/absolute/path/to/strava-mcp-server/dist/server.js` |
| Working directory | `/absolute/path/to/strava-mcp-server` |

Connect, open the Tools view, and run `validate_export` with `{}`. It reports a compact file delta and findings. It creates one `strava.sqlite` database under `STRAVA_MCP_DATA_DIR`; rerun the tool after downloading a refreshed export to record another validation snapshot. The source export is never modified.

## Configuration

| Variable | Required now | Meaning |
| --- | --- | --- |
| `STRAVA_EXPORT_DIR` | Required for validation | The immutable local source export. |
| `STRAVA_MCP_DATA_DIR` | No | Directory for generated local data. Defaults to `~/.strava-mcp-server`. |

The server rejects a data directory that is the export directory itself or is
nested inside it (or vice versa). This prevents generated cache files from
being written into the immutable source export.

Exact coordinates, privacy zones, IP addresses, emails, and device identifiers are sensitive. Validation deliberately reports only paths, counts, formats, and structural issues; it does not expose activity telemetry or account fields.

## Data and Git hygiene
Do not commit a real Strava export, generated database, API credential, or
privacy-sensitive test artifact. The repository ignores the following local
paths and SQLite cache files:

- `local-data/` — optional temporary export staging directory
- `local-cache/` and `.strava-mcp-server/` — generated local data
- `*.sqlite`, SQLite write-ahead logs, and SQLite journals
- `.env`, `.env.local`, and `.env.*.local` configuration files

Use anonymized, minimal fixtures for tests. Keep a real export outside this
repository; the default generated cache is also external.
