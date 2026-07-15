# Cursor Usage Tracker

VS Code / Cursor extension that reads your local Cursor login credentials and syncs **official billing / usage data** into SQLite, then visualizes day / month / year usage with ECharts.

No Electron hook or network capture is required.

## How it works

1. Reads `cursorAuth/accessToken` from Cursor's local `state.vscdb`
2. Calls official endpoints:
   - `api2.cursor.sh` — period usage (plan spend / limits)
   - `cursor.com/api` — usage summary + per-request events (token / cost)
3. Stores billing period + usage events in `~/.cursor-usage-tracker/usage.db`
4. Dashboard charts model distribution, kind breakdown, tokens, and cost

## Quick start

```bash
npm install
npm run build
```

Then press **F5** (Run Extension) or install the extension from this folder.

## Commands

| Command | Description |
|---------|-------------|
| **CursorUsage: Show Dashboard** | Open usage charts |
| **CursorUsage: Sync Billing** | Force refresh from official APIs |
| **CursorUsage: Export Data** | Export usage events as CSV |
| **CursorUsage: Open Tokens Log** | Open `~/.cursor-usage-tracker/usage-tokens.jsonl` |
| **CursorUsage: Show Status** | Show local DB / tokens log status |

## Requirements

- Cursor must be signed in on this machine (so `state.vscdb` has a valid access token)
- Network access to `api2.cursor.sh` and `cursor.com`

## Local data

All data lives under `~/.cursor-usage-tracker/`:

| File | Purpose |
|------|---------|
| `usage.db` | SQLite: billing periods + usage events |
| `usage-tokens.jsonl` | Last sync's full tokenUsage dump |

## Preview dashboard (browser)

```bash
npm run preview
```

Serves the dashboard HTML with mock data for UI work outside the extension host.

## Migrating from the old hook-based version

Network capture / Electron patching has been removed. If you previously ran **Install Hook**:

1. Restore Cursor's `main.js` from `~/.cursor-usage-tracker/main.js.bak` (or reinstall Cursor)
2. Restart Cursor
3. Use **Sync Billing** — data now comes only from official APIs

Old `requests.jsonl` / capture tables are no longer used. Billing events already in `usage.db` are kept.
