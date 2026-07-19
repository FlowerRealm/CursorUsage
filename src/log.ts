import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Cursor Usage');
  context.subscriptions.push(channel);
}

export function logSync(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  channel?.appendLine(line);
}
