# Cursor Usage Tracker

VS Code / Cursor extension that reads your local Cursor login credentials and syncs **official billing / usage data** into SQLite, then visualizes day / month / year usage with ECharts.

No Electron hook or network capture is required.

## How it works

1. Reads `cursorAuth/accessToken` from Cursor's local `state.vscdb`
2. Calls official endpoints:
   - `api2.cursor.sh` — period usage (plan spend / limits)
   - `cursor.com/api` — usage summary + per-request events (token / cost)
3. Stores billing period + usage events in `~/.cursor-usage-tracker/db/usage.db`
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
| **CursorUsage: Open Tokens Log** | Open `~/.cursor-usage-tracker/logs/usage-tokens.jsonl` |
| **CursorUsage: Show Status** | Show local DB / tokens log status |

## Requirements

- Cursor must be signed in on this machine (so `state.vscdb` has a valid access token)
- Network access to `api2.cursor.sh` and `cursor.com`

## Local data

All data lives under `~/.cursor-usage-tracker/`:

| Path | Purpose |
|------|---------|
| `db/usage.db` | SQLite: billing periods + usage events |
| `logs/usage-tokens.jsonl` | Last sync's full tokenUsage dump |
| `tmp/` | Temporary files for atomic writes |

## Package (VSIX)

```bash
npm install
npm run package
```

This typechecks, builds with esbuild, and produces `cursor-usage-tracker-<version>.vsix`.

Install locally:

```bash
# Cursor / VS Code CLI
cursor --install-extension cursor-usage-tracker-*.vsix
# or
code --install-extension cursor-usage-tracker-*.vsix
```

Or use **Extensions: Install from VSIX…** in the command palette.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push / PR to `main` or `master`:

1. `npm ci`
2. Typecheck
3. Package VSIX
4. Upload artifact `cursor-usage-tracker` (`cursor-usage-tracker.vsix`)

Pushing a tag `v*` (e.g. `v0.2.2`) also:

1. Creates a GitHub Release with the VSIX attached
2. Publishes the same VSIX to [Open VSX](https://open-vsx.org) (Cursor marketplace mirror)

### One-time Open VSX setup

1. Sign in at [open-vsx.org](https://open-vsx.org) (GitHub / Eclipse account)
2. Create an access token: [User Settings → Tokens](https://open-vsx.org/user-settings/tokens)
3. Add it as a repo secret:

```bash
gh secret set OVSX_PAT
```

Publisher namespace must match `package.json` → `publisher` (`cursor-usage`). CI creates the namespace on first publish if needed.

Manual publish without a new tag: **Actions → CI → Run workflow** → enable **Also publish… to Open VSX**.

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
