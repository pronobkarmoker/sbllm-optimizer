import * as vscode from 'vscode';

export const SBLLM_DIFF_SCHEME = 'sbllm-optimized';

/** Serves virtual read-only documents so the native diff editor can compare original vs. optimized
 *  code without touching any real file on disk (ARCHITECTURE.md §8: reuse the built-in diff view). */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}
