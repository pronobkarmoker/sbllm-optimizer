import * as vscode from 'vscode';
import type { LanguageId } from '../core/lang/languageAdapter.js';

export interface HistoryRecord {
  id: string;
  timestamp: string;
  file: string;
  functionName: string;
  language: LanguageId;
  model: string;
  improved: boolean;
  speedup: number | null;
  baselineMs: number | null;
  optimizedMs: number | null;
  candidatesEvaluated: number;
  iterations: number;
  originalCode: string;
  bestCode: string | null;
  applied: boolean;
}

const MAX_RECORDS = 100;

/**
 * Persists a summary of every optimization run as JSON in the extension's global storage, so past
 * results (and the code they produced) survive restarts and can be reviewed or re-applied.
 */
export class HistoryStore {
  private readonly file: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.file = vscode.Uri.joinPath(context.globalStorageUri, 'optimization-history.json');
  }

  async list(): Promise<HistoryRecord[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async add(record: HistoryRecord): Promise<void> {
    const all = await this.list();
    const next = [record, ...all.filter((r) => r.id !== record.id)].slice(0, MAX_RECORDS);
    await this.write(next);
  }

  async markApplied(id: string): Promise<void> {
    const all = await this.list();
    const hit = all.find((r) => r.id === id);
    if (!hit) return;
    hit.applied = true;
    await this.write(all);
  }

  async clear(): Promise<void> {
    await this.write([]);
  }

  private async write(records: HistoryRecord[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
    await vscode.workspace.fs.writeFile(this.file, Buffer.from(JSON.stringify(records, null, 2), 'utf8'));
  }
}
