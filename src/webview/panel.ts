import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getDashboardData, ViewMode, DashboardData } from '../analytics/aggregator';
import { importNewEntries } from '../storage/importer';
import { syncBilling } from '../billing/sync';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private view: ViewMode = 'day';
  private aiOnly = true;
  private syncing = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type === 'setView') {
          this.view = msg.view as ViewMode;
          this.pushData();
        } else if (msg.type === 'setAiOnly') {
          this.aiOnly = !!msg.aiOnly;
          this.pushData();
        } else if (msg.type === 'refresh') {
          await this.refreshAll();
        } else if (msg.type === 'ready') {
          this.pushData();
          void this.refreshAll(false);
        }
      },
      null,
      this.disposables
    );
  }

  public static show(extensionUri: vscode.Uri): DashboardPanel {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      DashboardPanel.currentPanel.pushData();
      void DashboardPanel.currentPanel.refreshAll(false);
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'cursorUsageDashboard',
      'Cursor Usage',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri);
    return DashboardPanel.currentPanel;
  }

  public pushData(syncNote?: string): void {
    try {
      importNewEntries();
      const data: DashboardData = getDashboardData(this.view, this.aiOnly);
      this.panel.webview.postMessage({
        type: 'data',
        payload: data,
        syncNote: syncNote || null
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.panel.webview.postMessage({ type: 'error', message: msg });
    }
  }

  private async refreshAll(showStatus = true): Promise<void> {
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    this.panel.webview.postMessage({ type: 'syncing', value: true });
    try {
      importNewEntries();
      const result = await syncBilling();
      let note = '';
      if (result.ok) {
        note = `Billing: ${result.source}`;
        if (result.eventsImported) {
          note += ` · ${result.eventsImported} events`;
        }
        if (result.planHint) {
          note += ` · ${result.planHint}`;
        }
        if (result.warnings.length) {
          note += ` · warn: ${result.warnings[0]}`;
        }
        if (showStatus) {
          vscode.window.setStatusBarMessage(`Cursor Usage synced (${result.source})`, 4000);
        }
      } else {
        note = `Billing sync failed: ${result.error || 'unknown'}`;
        if (showStatus) {
          vscode.window.showWarningMessage(note);
        }
      }
      this.pushData(note);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.panel.webview.postMessage({ type: 'error', message: msg });
    } finally {
      this.syncing = false;
      this.panel.webview.postMessage({ type: 'syncing', value: false });
    }
  }

  private getHtml(extensionUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, 'dist', 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net`,
      `script-src ${this.panel.webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net`,
      `img-src ${this.panel.webview.cspSource} https: data:`,
      `font-src ${this.panel.webview.cspSource} https://cdn.jsdelivr.net data:`,
      `connect-src https://cdn.jsdelivr.net`,
      `img-src ${this.panel.webview.cspSource} https: data:`
    ].join('; ');
    html = html.replace('{{CSP}}', csp);
    return html;
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}
