import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR, ensureDataDir, TOKENS_LOG_FILE, migrateLegacyFiles } from './paths';
import { initDatabase, closeDatabase, getTotalEventCount } from './storage/database';
import { exportCsv } from './analytics/aggregator';
import { DashboardPanel } from './webview/panel';
import { syncBilling } from './billing/sync';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureDataDir();
  migrateLegacyFiles();
  await initDatabase(context.extensionPath);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.showDashboard', () => {
      DashboardPanel.show(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.syncBilling', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing Cursor billing…'
        },
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
    vscode.commands.registerCommand('cursorUsage.exportData', async () => {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(os.homedir(), `cursor-usage-${new Date().toISOString().slice(0, 10)}.csv`)
        ),
        filters: { CSV: ['csv'] }
      });
      if (!uri) {
        return;
      }
      const csv = exportCsv();
      fs.writeFileSync(uri.fsPath, csv, 'utf8');
      vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.openTokensLog', async () => {
      if (!fs.existsSync(TOKENS_LOG_FILE)) {
        vscode.window.showWarningMessage(
          'Tokens log not found yet. Run CursorUsage: Sync Billing first.'
        );
        return;
      }
      const document = await vscode.workspace.openTextDocument(TOKENS_LOG_FILE);
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.showStatus', async () => {
      const eventCount = getTotalEventCount();
      const text = [
        `Data dir: ${DATA_DIR}`,
        `Usage events in SQLite: ${eventCount}`,
        `Tokens log: ${fs.existsSync(TOKENS_LOG_FILE) ? TOKENS_LOG_FILE : '(missing)'}`
      ].join('\n');
      await vscode.window.showInformationMessage(text, { modal: true });
    })
  );
}

export function deactivate(): void {
  closeDatabase();
}
