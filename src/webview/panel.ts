import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getDashboardData, ViewMode, DashboardData } from '../analytics/aggregator';
import { syncBilling } from '../billing/sync';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private view: ViewMode = 'month';
  private syncing = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === 'setView') {
          this.view = message.view as ViewMode;
          this.pushData();
        } else if (message.type === 'refresh') {
          await this.refreshAll(true);
        } else if (message.type === 'ready') {
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
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'icons')
        ]
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'icons', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'icons', 'icon-dark.svg')
    };

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri);
    return DashboardPanel.currentPanel;
  }

  public pushData(syncNote?: string): void {
    try {
      const data: DashboardData = getDashboardData(this.view);
      this.panel.webview.postMessage({
        type: 'data',
        payload: data,
        syncNote: syncNote || null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.postMessage({ type: 'error', message });
    }
  }

  private async refreshAll(forceRefresh = false): Promise<void> {
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    this.panel.webview.postMessage({ type: 'syncing', value: true });
    try {
      const result = await syncBilling(forceRefresh);
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
      } else {
        note = `Sync failed: ${result.error || 'unknown'}`;
        if (result.warnings.length) {
          note += ` · ${result.warnings[0]}`;
        }
      }
      this.pushData(note);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.postMessage({ type: 'error', message });
    } finally {
      this.syncing = false;
      this.panel.webview.postMessage({ type: 'syncing', value: false });
    }
  }

  private getHtml(extensionUri: vscode.Uri): string {
    const htmlPath = path.join(extensionUri.fsPath, 'dist', 'dashboard.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const cspSource = this.panel.webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} https: data:`,
      `script-src ${cspSource} https://cdn.jsdelivr.net 'unsafe-inline'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `font-src ${cspSource} https: data:`,
      `connect-src https://cdn.jsdelivr.net`
    ].join('; ');
    const iconDark = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'icons', 'icon-dark.svg')
    );
    const iconLight = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'icons', 'icon-light.svg')
    );
    html = html
      .replace('{{CSP}}', csp)
      .replace(/\{\{ICON_DARK\}\}/g, iconDark.toString())
      .replace(/\{\{ICON_LIGHT\}\}/g, iconLight.toString());
    return html;
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
