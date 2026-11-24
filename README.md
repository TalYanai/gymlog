# GymLog V2

Personal training and workout tracking application built with zero-dependency Vanilla ES2022 Modules, HTML, and CSS (PWA).

## Why

Workout apps lose entries without a signal in the gym, and I wanted to import my own Garmin history and keep the data in my own hands. This is a single-user project, built to learn offline-first design and a small sync service on Cloudflare.

## How it works

- **Client:** a vanilla ES-module PWA, no runtime dependencies. State is stored locally behind a schema validator and works offline.
- **Sync:** a Cloudflare Worker (`/api/sync/*`) writes to D1 as an append-only log of versioned changes. `UNIQUE(type, id, version)` acts as an optimistic lock, `UNIQUE(op_id)` makes retried requests idempotent, deletes are tombstones, and conflicts are returned to the client.
- **Import and backup:** Garmin CSV and archive importers, and backup and restore with SHA-256 integrity checks.

## Tests

`npm test` runs the Node test runner (`node --test`) over unit, domain, import, UI-model and sync-server tests, using synthetic fixtures only.

## Limits

- One user and one shared bearer token, not per-user accounts.
- No CI workflow yet.
- The sync tests use a D1 test helper rather than a real D1.
- The interface is in Hebrew (right-to-left).

## Deploying your own copy

1. `npx wrangler d1 create gymlog`, then put the database id in `wrangler.toml` (it is a placeholder in this repository).
2. `npx wrangler secret put SYNC_TOKEN`.
3. Set `PRODUCTION_HOST` in `src/ui/config.js` to your own Worker host, so the app recognises its production origin.
4. `powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -Url https://<your-worker>.workers.dev`

## Architecture Overview

- **`src/schema/`**: Schema v2 constants, strict field allowlists, RFC 8785 JCS canonicalization, SHA-256 hashing, entity factories, seed validation, and full-store invariant validation (`validateStore`).
- **`src/store/`**: Storage adapter (`localStorage`), side-key management (`gymlog.v2.prev`, `gymlog.v2.importProof`, `gymlog.v2.input`, `gymlog.legacy.*`), seed catalog loading, and the atomic FIFO Store (`store.js`).
- **`src/core/`**: Pure domain mutators for active workout sessions, set logging, history editing, conflict resolution, goals, templates, custom exercises, and write-boundary transition rules (`transitions.js`).
- **`src/derive/`**: Pure derived calculations for official records, Epley e1RM estimates, manual record comparisons, volume, exact-distance 10K results, run splits, and goal evaluation.
- **`src/import/`**: Importers and planners for V1/V3 initial migration, V1/V3 late imports, Garmin `unified_workouts.csv` historical imports, and `gymlog-personal.json` personal seed items.
- **`src/backup/`**: Full and partial JSON backup creation and verified restoration with SHA-256 integrity checks.
- **`src/app/`**: Application state-machine gate (`bootstrap.js`) coordinating startup, recovery, imports, and normal writes.
- **`src/ui/`**: Pure view-models (`*-model.js`), RTL Hebrew DOM renderers (`h()` builder with zero `innerHTML`), keystroke draft buffer (`input-buffer.js`), hash router, and PWA update manager.

## Requirements

- **Node.js**: `>= 20.0.0` (tested on Node.js v24)
- **Zero external runtime dependencies**

## Development Commands

### 1. Run Automated Tests
Runs the Node.js native test runner (`node --test`) across all unit, domain, import, UI model, and regression tests using synthetic fixtures only:

```bash
npm test
```

### 2. Start Local Development Server
Starts a loopback-only (`127.0.0.1`) HTTP development server on port `4173` (or `PORT` env var) with strict Content-Security-Policy headers and explicit blocking of personal/non-runtime files:

```bash
npm run dev
```

Open `http://localhost:4173/` in a desktop browser.
- Local development runs in `local` environment mode (`env.localDev === true`), using the browser's isolated `localhost` origin and `localStorage` (completely separate from production storage).
- Import and restore workflows are enabled on `localhost` / `127.0.0.1` for testing with synthetic data, while arbitrary non-production hosts remain strictly in `preview` mode (`dataTransfer: 'preview'`).

### 3. Build Production Distribution
Builds the clean `dist/` folder, updates `precache.json` with a deterministic 16-hex SHA-256 version identifier, verifies that no personal data, CSVs, backups, or development files are included, and packages `dist/gymlog-dist-<version>.zip`:

```bash
npm run build
```

## Data Safety & Privacy Rules

- Never commit `gymlog-personal.json`, `unified_workouts.csv`, `*.csv`, `gymlog-backup-*.json`, or `*.zip` archives. All are excluded via `.gitignore` and rejected by `scripts/build-dist.mjs` and `scripts/dev-server.mjs`.
- Never use personal workout data in automated or manual dev tests; use synthetic test fixtures only.
