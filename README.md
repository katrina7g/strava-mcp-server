# Strava MCP Server

A local, read-only [Model Context Protocol](https://modelcontextprotocol.io)
server for a bulk export of a Strava profile. It lets an MCP client explore your
training history without uploading the export anywhere or modifying it. The
server answers questions about activities, training trends, sport-specific
progress, routes, and whichever device metrics your files happen to contain.

## What this project is

- **Local-only.** No cloud storage, no Strava API access, no OAuth. Everything
  runs on your machine against files already on disk.
- **Read-only.** The server never creates, edits, deletes, or uploads anything
  in Strava. The source export is treated as immutable. The server validates
  and imports it, and never writes to it.
- **Privacy-first.** Coordinates are omitted from every tool response unless
  that specific request opts in. Account sources such as profile, login,
  privacy zones, and connected devices are never parsed at all, so the email
  addresses, IP addresses, and device identifiers they contain never reach the
  database or a response. See [Data](#data) below.

It does not support multi-user access, hosted deployment, webhooks, or ongoing
automatic Strava synchronization. Data is refreshed by the user requesting a new
export and running the import again, which is idempotent.

## Prerequisites

- Node.js 20 or newer
- A local Strava data export (Strava account settings → **Download or Delete
  Your Account** → **Request Your Archive**)

## Install and verify

```bash
git clone https://github.com/katrina7g/strava-mcp-server.git
cd strava-mcp-server
npm install

npm run typecheck
npm test
npm run build
```

## Quick start

Point the server at the export directory and, optionally, where its local
database should live:

```bash
export STRAVA_EXPORT_DIR="/absolute/path/to/strava-export"
export STRAVA_MCP_DATA_DIR="$HOME/.strava-mcp-server"   # this is the default

npm run build
npm start
```

`npm start` and `npm run dev` intentionally appear idle when run directly. An
MCP server waits for a client connection over standard input, so a client 
connection is required for usage.

The server creates a
SQLite database, `strava.sqlite`, under `STRAVA_MCP_DATA_DIR`, with
current-user-only file permissions where the platform supports them. The server
never writes inside `STRAVA_EXPORT_DIR`. A
distinct export should use a distinct data directory; the two directories may
not be nested inside one another.

### First import

Call these three tools once, in order, through any connected MCP client:

1. `validate_export` reads the export and reports its structure. It changes
   neither the export nor the database.
2. `import_activity_catalog` imports `activities.csv`. It prints a delta of
   inserted, changed, unchanged, and no-longer-observed activities.
3. `import_supporting_data` imports gear, meaning shoes, bikes, and
   components, plus media references, challenges, clubs, memberships, and an
   aggregate social summary, linking each to the activities that reference it.

Then, optionally:

4. `import_detailed_activities` decodes linked GPX, FIT, `.fit.gz`, and
   `.tcx.gz` files into streams, laps, and route bounds. This is the slowest
   step. Pass `activityId` to import one activity at a time.

### Re-importing

Strava exports are static snapshots. To pick up new activities, request a
fresh export and run the same tools against it again. Each import compares the
new export against the state already stored and reports a compact delta, so a
re-import is cheap and tells you exactly what changed. Running
`validate_export` on its own is always safe and never modifies the database.

## Using it with an MCP client

### Claude Desktop / any client reading `claude_desktop_config.json`-style config

```json
{
  "mcpServers": {
    "strava": {
      "command": "node",
      "args": ["/absolute/path/to/strava-mcp-server/dist/server.js"],
      "env": {
        "STRAVA_EXPORT_DIR": "/absolute/path/to/strava-export",
        "STRAVA_MCP_DATA_DIR": "/absolute/path/to/.strava-mcp-server"
      }
    }
  }
}
```

`STRAVA_MCP_DATA_DIR` can be omitted to use the default,
`~/.strava-mcp-server`. Add `STRAVA_MCP_TIMEZONE` with an IANA zone name such
as `America/Los_Angeles` if you want a fallback local time zone for activities
whose device did not record one. See [Time zones](#time-zones) for how that
fallback is applied.

`package.json` declares a `bin` entry, so once the package is linked with
`npm link` the command can be `strava-mcp-server` instead of
`node .../dist/server.js`. This repository is not published to npm, so the
absolute-path form shown above is the reliable option.

### MCP Inspector (manual testing)

```bash
npm run build
npx --yes @modelcontextprotocol/inspector
```

Open the Inspector URL it prints, add a server with:

| Field | Value |
| --- | --- |
| Transport | `STDIO` |
| Command | `node` |
| Arguments | `/absolute/path/to/strava-mcp-server/dist/server.js` |
| Working directory | `/absolute/path/to/strava-mcp-server` |

Connect, open the Tools view, and run `validate_export` with `{}` to confirm
the export is readable before importing.

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript server in watch mode. |
| `npm run build` | Compile `src/` to `dist/` and mark the entry point executable. |
| `npm run start` | Run the compiled stdio server. |
| `npm run typecheck` | Typecheck production and test TypeScript. |
| `npm test` | Run the test suite once. |
| `npm run test:unit` | Pure derivation and parsing tests, no database. |
| `npm run test:integration` | Database-backed import and query tests. |
| `npm run test:functional` | Tests driving the real MCP tool surface. |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run bench` | Build, then measure import cost against `STRAVA_EXPORT_DIR`. |

## Performance

`npm run bench` builds and then imports the export named by
`STRAVA_EXPORT_DIR` into a temporary data directory, reporting per-phase wall
time, rows written, database size, and peak resident memory as JSON. It never
touches the configured `STRAVA_MCP_DATA_DIR` unless you pass `--reuse`.

Rough shape on a mid-size export of a few hundred activities, Node 24 on
darwin-arm64. Run it against your own export for numbers that mean anything:

| Phase | Relative cost |
| --- | --- |
| `validate` | under a second |
| `catalog` | tens of milliseconds |
| `supporting` | negligible |
| `detailed` cold | seconds, and dominates the total |
| `detailed` re-run, nothing changed | milliseconds |
| `detailed` with `force` | slightly more than the cold run |

Decoding dominates, which is why an unchanged file is skipped rather than
decoded again, and why the warm re-run is three orders of magnitude cheaper
than the cold one. A forced re-decode costs more than the cold run because it
deletes existing rows first. Deriving both split series adds roughly ten
percent to the cold decode. Stream points, not activities, drive database
size and peak memory.

## Tool reference

Every tool returns a JSON text payload. List and telemetry results are
paginated or bounded; grouped results report `truncated` and `totalGroups`
when a cap is hit.

**Setup and import**

| Tool | Purpose |
| --- | --- |
| `get_server_info` | Server identity, version, and whether an export is configured. |
| `validate_export` | Read-only structural check of the configured export. Records a snapshot; never modifies the export. |
| `import_activity_catalog` | Imports `activities.csv`. Reports a new/changed/unchanged/no-longer-observed delta. |
| `import_supporting_data` | Imports supporting domains: gear, media references, challenges, clubs, and memberships, over the same delta contract. |
| `import_detailed_activities` | Decodes GPX/FIT/`.fit.gz`/`.tcx.gz` files into streams, laps, bounds, and splits. Unchanged files are skipped; pass `force` to decode anyway. Per-file failures don't stop the rest. |

**Archive and schema**

| Tool | Purpose |
| --- | --- |
| `get_archive_summary` | Coverage, sport counts, imported/empty/not-imported domains, and latest snapshot health. |
| `get_data_schema` | Field names, types, units, and privacy classification, optionally scoped to one domain (`activities`, `gear`, `splits`, `media`, `challenges`, `clubs`, `social`). |

**Activities**

| Tool | Purpose |
| --- | --- |
| `search_activities` | Filter by sport, date range, distance, duration, effort, or text; paginated. |
| `aggregate_training` | Volume/duration/elevation/effort totals grouped by day, week, month, or sport. |
| `get_activity` | One activity's catalog metadata, derived metrics, file/decode status, and telemetry availability. Never returns coordinates. |
| `get_activity_stream` | Bounded telemetry points, each with its `distanceSource`. Coordinates require `includeLocation: true` on that request. |
| `get_activity_route` | Simplified route as GeoJSON, or a non-coordinate summary. Also requires `includeLocation: true` for geometry. |
| `analyze_activity` | Catalog-level pace/intensity analysis, plus `splits`, `progression`, and `pauses` from decoded telemetry over 1 km or 1 mile intervals. Falls back to the catalog answer, with a reason, when no eligible route exists. |

**Training analysis**

| Tool | Purpose |
| --- | --- |
| `list_sports` | Sports actually present in the import, with per-sport metric coverage. |
| `get_sport_summary` | One sport's volume, pace, and other metrics grouped over time. |
| `compare_training_periods` | Metric deltas between two date ranges. |
| `get_personal_bests` | Best activities for one sport and metric, with the definition used. |
| `get_training_load` | Grouped training-load proxy; always states whether the value is supplied or derived. |

**Supporting data**

| Tool | Purpose |
| --- | --- |
| `get_gear` | Imported gear with usage counts and distance, paginated. |
| `list_media` | Imported media references with captions and activity links, paginated. Stores paths and captions only. |
| `get_challenges` | Imported global and group challenges with join dates and completion, paginated. |
| `get_clubs` | Imported clubs and the account's memberships, paginated. |
| `get_social_summary` | Aggregate counts of outbound social activity. Stores counts only, never identifiers or comment text. |

**Resources**

| URI | Contents |
| --- | --- |
| `strava://schema` | The `get_data_schema` payload, for clients that prefer resources over tool calls. |
| `strava://archive-summary` | The `get_archive_summary` payload. |
| `strava://privacy-policy` | Static text describing this server's coordinate opt-in and what it never imports. |

## Data

The server runs locally, but a tool response may not stay local. The tool's result 
is sent to the connected MCP client, and most clients forward
that text to a model running on external infrastructure. Redaction here
means keeping sensitive values out of tool responses, so that connecting a
hosted client does not send all profile data off your machine.

**Coordinates are imported but not returned by default.** Latitude and
longitude are decoded from your GPX, FIT, and TCX files and stored in the
local database, because route and stream queries need them. They are omitted
from every tool response unless the request sets `includeLocation: true`.
`get_activity_route` and `get_activity_stream` are the only tools that can
ever return them. Asking for a coordinate field by name is not enough on its
own, since the field is dropped and reported as withheld. The opt-in applies
to one request and is never stored, inferred, or reused for a later call.
`get_activity` never returns coordinates at any detail level.

**Media is referenced, never read.** `list_media` reports the relative path
and caption of each photo or video the export references, and which activities
reference it. No media byte is ever read and no EXIF is extracted, so the
location, device, and timestamp metadata embedded in a photo never enters the
database. A path is stored only after it is confirmed to resolve inside the
export's `media` directory; anything escaping that root is rejected and
reported. A reference whose file is absent is kept and flagged rather than
silently dropped, and a media row no activity references is kept too.

**Social data is counted, never stored.** `followers.csv`, `following.csv`,
`reactions.csv`, and `comments.csv` are the only sources describing other
people: two are lists of third-party athlete IDs, reactions point at parent
activities that need not be yours, and comments hold free text. The importer
counts rows and discards every one of those values, so the database holds
totals and month buckets and nothing else. No third-party identifier and no
comment text can be returned, because neither is ever written down. Every
figure is outbound; kudos and comments received are absent from an export and
cannot be derived from one.

**Account sources are never parsed at all.** Profile, login,
device-identifier, privacy-zone, preference, connected-app, contact, block,
and flag files, along with `messaging.json`, are hashed into
`source_manifest` so that a re-import can detect that they changed. Nothing
inside them is read into a table. The email addresses, IP addresses, and
device identifiers those files hold therefore never enter the database, and no
tool can return them. Media bytes are never ingested and EXIF is never
extracted.

List results paginate and telemetry responses are capped, and a grouped result 
reports that it was truncated rather than returning an unbounded series. A 
missing metric is reported as unavailable rather than as zero, because device
and export coverage differs by activity, sport, and file format.

The `strava://privacy-policy` resource states these same rules in a form a
client can read without the README. It describes this server's behavior only.
It is not Strava's privacy policy, and no implications about how Strava handles
 data.

## Time zones

Every timestamp in a Strava export is UTC, with no zone marker. Grouped
results (day/week/month buckets in `aggregate_training`, `get_sport_summary`,
and `get_training_load`) default to local-time boundaries where a local time
is known, and fall back to UTC otherwise, because grouping by UTC alone can
put an evening activity in the wrong calendar day. Each grouped response
states which basis (`local` or `utc`) it used and reports offset-source
coverage.

The local offset comes from, in order:

1. **The FIT file itself**, when one was imported. A FIT file records both a
   UTC and a local timestamp, so this offset is accurate per activity, even
   across travel and daylight saving.
2. **`STRAVA_MCP_TIMEZONE`**, an optional IANA zone name such as
   `America/Los_Angeles`. It is a fallback for GPX and TCX activities, which
   carry no offset of their own. It is wrong for any activity recorded while
   you were travelling outside that zone.
3. **UTC**, explicitly labelled as such, when neither source applies.

Pass `timeBasis: "utc"` to any of the three grouping tools to bypass local
time and group by UTC calendar boundaries instead.

## Distance, splits, and what they are derived from

Two thirds of a typical export carries no per-point distance at all, so a
split boundary cannot always be measured. Each activity therefore states where
its distance came from, and tools that depend on it say so in their responses.

- **`supplied`** — the file recorded distance per point. FIT and some TCX
  files do. This is used exactly as recorded.
- **`catalog-normalized-path`** — a GPX or TCX route with no recorded
  distance, whose cumulative position was scaled to the total distance the
  activity catalog reports. The route decides *where* progress happened; the
  catalog decides *how far*. This is not a measured odometer, and every
  response built on it says so.
- **`none`** — neither is available, so no splits are derived and the reason
  is reported instead of a fabricated number.

Normalization is only applied to a route that passes continuity checks: enough
valid coordinates and timestamps, no discontinuity large enough to make
position ambiguous, and a bounded difference between the raw GPS length and
the catalog total. A route that fails any check is reported as ineligible with
the reason, without coordinates. Raw GPS length and its error against the
catalog are kept as internal diagnostics and are never used as a split basis.

`analyze_activity` derives 1 km and 1 mile splits from that distance, with
pace, heart rate, cadence, power, and separated elevation gain and loss. Each
split lists the metrics it actually carries, so an absent metric is never read
as a zero. A pause is movement below 0.5 m/s; a gap of more than 30 seconds
that still covers ground is a hole in the recording rather than a rest, and is
counted separately as `recordingGapCount`.

## Data and Git hygiene

Do not commit a real Strava export, a generated database, an API credential,
or a privacy-sensitive test artifact. The repository ignores:

- `local-data/`, an optional staging directory for a temporary export
- `local-cache/` and `.strava-mcp-server/`, which hold generated local data
- `*.sqlite`, SQLite write-ahead logs, and SQLite journals
- `.env`, `.env.local`, and `.env.*.local` configuration files

Tests use a small, fully synthetic fixture export committed under
`tests/fixtures/`. Keep a real export, and the database generated from it,
outside this repository.

Tests are grouped by what they exercise: `tests/unit/` for pure derivation and
parsing, `tests/integration/` for database-backed import and query behaviour,
and `tests/functional/` for tests that drive the MCP tool surface over the
real transport.

## Configuration reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `STRAVA_EXPORT_DIR` | For any import or query tool | The immutable local source export. |
| `STRAVA_MCP_DATA_DIR` | No | Directory for the generated local database. Defaults to `~/.strava-mcp-server`. |
| `STRAVA_MCP_TIMEZONE` | No | IANA time zone name used as the local-time fallback for activities with no per-activity offset. |

`STRAVA_EXPORT_DIR` and `STRAVA_MCP_DATA_DIR` may not be the same directory
or nested inside one another, so generated cache files can never be written
into the immutable source export.

## Native dependency: `better-sqlite3`

The local database uses [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3),
a native C++ addon rather than a pure-JavaScript package. `npm install`
downloads a prebuilt binary matching your platform, CPU architecture, and
Node ABI when one is available; otherwise it compiles from source via
node-gyp, which requires Python 3 and a C++ toolchain (Xcode Command Line
Tools on macOS, `build-essential` on Debian/Ubuntu). Alpine/musl and less
common architectures are the platforms most likely to need that fallback.

The addon is compiled against one Node ABI. If you switch the Node major
version this project runs under, rebuild it for the new ABI:

```bash
npm rebuild better-sqlite3
```

## Out of scope

- Creating, editing, deleting, uploading, or changing anything in Strava.
- Hosted deployment, cloud storage, or sending export data to a remote
  service.
- Authentication, OAuth, live Strava API access, webhooks, or ongoing
  automatic Strava synchronization.
- Multi-user tenancy or combining with another person's data.
- A promise that derived values exactly reproduce every Strava UI metric. Each
  tool states the formula it used in its own response.
- Unbounded raw-stream delivery, unrestricted SQL execution, or automatic
  EXIF location extraction.
- Kudos and comments received. A Strava export describes outbound activity
  only, so no inbound figure can be derived and none is reported.
- Reading media bytes or extracting EXIF. Media is referenced by path and
  caption only.
