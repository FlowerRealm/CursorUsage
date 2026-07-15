import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  patch,
  unpatch,
  getStatus,
  formatStatus,
  LOG_FILE,
  DETAIL_LOG_FILE,
  TOKENS_LOG_FILE,
  ensureDataDir,
  enableDetailLogging,
  disableDetailLogging,
  isDetailLoggingEnabled
} from './patcher';
import { initDatabase, closeDatabase, getTotalCount } from './storage/database';
import { importNewEntries } from './storage/importer';
import { exportCsv } from './analytics/aggregator';
import { DashboardPanel } from './webview/panel';
import { syncBilling } from './billing/sync';

let logWatcher: fs.FSWatcher | undefined;
let importTimer: NodeJS.Timeout | undefined;

function scheduleImport(): void {
  if (importTimer) {
    clearTimeout(importTimer);
  }
  importTimer = setTimeout(() => {
    try {
      const { imported } = importNewEntries();
      if (imported > 0 && DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.pushData();
      }
    } catch (e) {
      console.error('[cursor-usage] import failed', e);
    }
  }, 500);
}

function startLogWatcher(): void {
  ensureDataDir();
  stopLogWatcher();

  try {
    logWatcher = fs.watch(path.dirname(LOG_FILE), (_event: string, filename: string | null) => {
      if (!filename || filename === 'requests.jsonl' || filename.startsWith('requests')) {
        scheduleImport();
      }
    });
  } catch (e) {
    console.error('[cursor-usage] failed to watch log dir', e);
  }

  scheduleImport();
}

function stopLogWatcher(): void {
  if (logWatcher) {
    logWatcher.close();
    logWatcher = undefined;
  }
  if (importTimer) {
    clearTimeout(importTimer);
    importTimer = undefined;
  }
}

function checkVersionOnActivate(): void {
  const status = getStatus();
  if (status.versionMismatch || (status.patchedVersion && !status.patched)) {
    vscode.window
      .showWarningMessage(
        `Cursor was updated (${status.patchedVersion} → ${status.cursorVersion}). Reinstall the usage tracking hook?`,
        'Reinstall Hook',
        'Later'
      )
      .then((choice) => {
        if (choice === 'Reinstall Hook') {
          const result = patch();
          if (result.ok) {
            vscode.window.showInformationMessage(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        }
      });
  } else if (!status.patched) {
    vscode.window
      .showInformationMessage(
        'Cursor Usage Tracker: network hook is not installed. Install it to start capturing requests?',
        'Install Hook',
        'Later'
      )
      .then((choice) => {
        if (choice === 'Install Hook') {
          const result = patch();
          if (result.ok) {
            vscode.window.showInformationMessage(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        }
      });
  } else if (status.needsUpgrade) {
    vscode.window
      .showWarningMessage(
        `Cursor Usage Tracker hook is outdated (v${status.hookVersion}). Upgrade to v0.2 for detail logging?`,
        'Upgrade Hook',
        'Later'
      )
      .then((choice) => {
        if (choice === 'Upgrade Hook') {
          const result = patch();
          if (result.ok) {
            vscode.window.showInformationMessage(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        }
      });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureDataDir();
  await initDatabase(context.extensionPath);

  try {
    importNewEntries();
  } catch (e) {
    console.error('[cursor-usage] initial import failed', e);
  }

  startLogWatcher();
  checkVersionOnActivate();

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.installHook', async () => {
      const result = patch();
      if (result.ok) {
        await vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.uninstallHook', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Uninstall the Cursor usage tracking hook?',
        { modal: true },
        'Uninstall'
      );
      if (confirm !== 'Uninstall') {
        return;
      }
      const result = unpatch();
      if (result.ok) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.showDashboard', () => {
      DashboardPanel.show(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.syncBilling', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Syncing Cursor billing…' },
        async () => {
          const result = await syncBilling(true);
          if (result.ok) {
            const bits = [
              result.source,
              result.eventsImported ? `${result.eventsImported} events` : null,
              result.planHint || null
            ].filter(Boolean);
            vscode.window.showInformationMessage(`Billing synced: ${bits.join(' · ')}`);
            if (DashboardPanel.currentPanel) {
              DashboardPanel.currentPanel.pushData(`Billing: ${bits.join(' · ')}`);
            }
          } else {
            vscode.window.showErrorMessage(`Billing sync failed: ${result.error}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.checkHookStatus', async () => {
      const status = getStatus();
      const dbCount = getTotalCount(false);
      const text = formatStatus(status) + `\nSQLite records: ${dbCount}`;
      await vscode.window.showInformationMessage(text, { modal: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.exportData', async () => {
      importNewEntries();
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(os.homedir(), `cursor-usage-${new Date().toISOString().slice(0, 10)}.csv`)
        ),
        filters: { CSV: ['csv'] }
      });
      if (!uri) {
        return;
      }
      const csv = exportCsv(false);
      fs.writeFileSync(uri.fsPath, csv, 'utf8');
      vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.enableDetailLogging', async () => {
      const status = getStatus();
      if (status.needsUpgrade || !status.patched) {
        const choice = await vscode.window.showWarningMessage(
          'Detail logging requires hook v0.2. Install/upgrade the hook first?',
          'Install Hook',
          'Cancel'
        );
        if (choice === 'Install Hook') {
          const result = patch();
          if (!result.ok) {
            vscode.window.showErrorMessage(result.message);
            return;
          }
          await vscode.window.showInformationMessage(result.message);
        } else {
          return;
        }
      }
      const result = enableDetailLogging();
      vscode.window.showInformationMessage(result.message);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.disableDetailLogging', () => {
      const result = disableDetailLogging();
      vscode.window.showInformationMessage(result.message);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.openDetailLog', async () => {
      ensureDataDir();
      if (!fs.existsSync(DETAIL_LOG_FILE)) {
        // Create empty file so user can see the path and watch it grow
        fs.writeFileSync(DETAIL_LOG_FILE, '');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(DETAIL_LOG_FILE));
      await vscode.window.showTextDocument(doc, { preview: false });
      const onOff = isDetailLoggingEnabled() ? 'ON' : 'OFF';
      vscode.window.setStatusBarMessage(
        `Request detail log opened (detail logging: ${onOff})`,
        4000
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.openTokensLog', async () => {
      ensureDataDir();
      if (!fs.existsSync(TOKENS_LOG_FILE)) {
        vscode.window.showInformationMessage(
          'Tokens log not created yet. Run Sync Billing / refresh Dashboard first.'
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(TOKENS_LOG_FILE));
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  context.subscriptions.push({
    dispose: () => {
      stopLogWatcher();
      closeDatabase();
    }
  });
}

export function deactivate(): void {
  stopLogWatcher();
  closeDatabase();
}
