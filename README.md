# Cursor Usage Tracker

VS Code / Cursor extension that patches Cursor's Electron main process to capture real `*.cursor.sh` network traffic, stores requests in SQLite, and visualizes day/week/month/year usage with ECharts.

## Quick start

```bash
npm install
npm run build
```

Then press **F5** (Run Extension) or install the extension from this folder.

## Commands

- **CursorUsage: Install Hook** — patch Cursor `main.js` (restart required)
- **CursorUsage: Uninstall Hook** — restore backup
- **CursorUsage: Show Dashboard** — open charts
- **CursorUsage: Export Data** — export CSV
- **CursorUsage: Check Hook Status** — show patch / log status
- **CursorUsage: Enable Detail Logging** — append rich request details to a separate file (default OFF)
- **CursorUsage: Disable Detail Logging** — stop writing details; **does not delete** the detail file
- **CursorUsage: Open Request Detail Log** — open `~/.cursor-usage-tracker/requests-detail.jsonl`

## Detail logging (debug)

Default is **off**. When enabled, each `*.cursor.sh` request also appends a richer JSON line to:

`~/.cursor-usage-tracker/requests-detail.jsonl`

Fields include: url, method, status, type, id, ip, fromCache, referrer, statusLine, resHeaders.

Toggle is controlled by flag file `detail-logging.on` (create = on, delete = off). Turning off never clears the detail log so you can re-enable and continue appending.

CLI:

```bash
node patch-cursor.mjs detail-on
node patch-cursor.mjs detail-off
```

### Hot-reload (v0.3+)

Capture logic lives in `~/.cursor-usage-tracker/hook.mjs`. After installing the v0.3 loader once:

```bash
node patch-cursor.mjs patch      # upgrades loader + writes hook.mjs (restart Cursor ONCE)
node patch-cursor.mjs sync-hook  # later: push repo hook.mjs → home (no restart)
```

Editing `hook.mjs` hot-reloads automatically — no Cursor restart needed unless the thin loader in `main.js` itself changes.
