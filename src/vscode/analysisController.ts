import * as vscode from 'vscode';
import { CodeAnalyzer, type FileAnalysis, type FunctionAnalysis } from '../core/analysis/analyzer.js';
import type { LanguageId } from '../core/lang/languageAdapter.js';

const SUPPORTED = new Set(['python', 'cpp']);
const MAX_FILE_CHARS = 400_000;

function languageOf(doc: vscode.TextDocument): LanguageId | null {
  return doc.languageId === 'python' ? 'python' : doc.languageId === 'cpp' ? 'cpp' : null;
}

function severityOf(s: string): vscode.DiagnosticSeverity {
  // Performance findings are advice, not errors: "warning" findings show as Information (listed in
  // the Problems panel), lesser ones as Hints (editor-only dots), so the panel isn't flooded.
  return s === 'warning' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;
}

/**
 * Runs static analysis on Python/C++ files and surfaces the results three ways: diagnostics with a
 * suggestion, a CodeLens above each flagged function ("⚡ 2 performance issues · O(n^2) —
 * Optimize with SBLLM"), and a quick fix on each diagnostic that launches the optimizer.
 */
export class AnalysisController implements vscode.CodeLensProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sbllm');
  private readonly results = new Map<string, { version: number; analysis: FileAnalysis }>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private analyzer: CodeAnalyzer;

  constructor(private readonly scriptsDir: string) {
    this.analyzer = this.createAnalyzer();

    const selector: vscode.DocumentSelector = [
      { language: 'python', scheme: 'file' },
      { language: 'cpp', scheme: 'file' },
      { language: 'python', scheme: 'untitled' },
      { language: 'cpp', scheme: 'untitled' },
    ];
    this.disposables.push(
      this.diagnostics,
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, 1200)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.diagnostics.delete(d.uri);
        this.results.delete(d.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sbllmOptimizer.pythonPath')) {
          this.analyzer = this.createAnalyzer();
          this.results.clear();
          this.refreshAll();
        } else if (e.affectsConfiguration('sbllmOptimizer.analysis')) {
          this.refreshAll();
        }
      }),
    );
    this.refreshAll();
  }

  private createAnalyzer(): CodeAnalyzer {
    const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
    return new CodeAnalyzer({ scriptsDir: this.scriptsDir, pythonPath: cfg.get<string>('pythonPath') });
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('sbllmOptimizer').get<boolean>('analysis.enabled', true);
  }

  refreshAll(): void {
    if (!this.enabled) {
      this.diagnostics.clear();
      this.results.clear();
      this.lensEmitter.fire();
      return;
    }
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc, 0);
  }

  private schedule(doc: vscode.TextDocument, delayMs: number): void {
    if (!SUPPORTED.has(doc.languageId) || !this.enabled) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.analyze(doc);
      }, delayMs),
    );
  }

  /** Analyzes `doc` (or returns the cached result for its current version). */
  async analyze(doc: vscode.TextDocument): Promise<FileAnalysis | null> {
    const language = languageOf(doc);
    if (!language) return null;
    const key = doc.uri.toString();
    const cached = this.results.get(key);
    if (cached && cached.version === doc.version) return cached.analysis;

    const text = doc.getText();
    if (text.length > MAX_FILE_CHARS) return null;
    const version = doc.version;
    const analysis = await this.analyzer.analyze(text, language);
    if (doc.isClosed || doc.version !== version) return analysis; // stale; a newer run is scheduled

    this.results.set(key, { version, analysis });
    this.publish(doc, analysis);
    return analysis;
  }

  private publish(doc: vscode.TextDocument, analysis: FileAnalysis): void {
    const diags: vscode.Diagnostic[] = [];
    for (const fn of analysis.functions) {
      for (const issue of fn.issues) {
        const range = new vscode.Range(issue.line, issue.col, issue.endLine, Math.max(issue.endCol, 0));
        const d = new vscode.Diagnostic(range, `${issue.message} ${issue.suggestion}`, severityOf(issue.severity));
        d.source = 'SBLLM';
        d.code = issue.kind;
        diags.push(d);
      }
    }
    this.diagnostics.set(doc.uri, diags);
    this.lensEmitter.fire();
  }

  functionAt(doc: vscode.TextDocument, line: number): FunctionAnalysis | undefined {
    const res = this.results.get(doc.uri.toString());
    return res?.analysis.functions.find((f) => f.startLine <= line && line <= f.endLine);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled || !vscode.workspace.getConfiguration('sbllmOptimizer').get<boolean>('analysis.codeLens', true)) return [];
    const res = this.results.get(doc.uri.toString());
    if (!res) return [];
    const showAll = vscode.workspace.getConfiguration('sbllmOptimizer').get<boolean>('analysis.codeLensForAllFunctions', false);
    const lenses: vscode.CodeLens[] = [];
    for (const fn of res.analysis.functions) {
      if (!fn.topLevel) continue;
      const warnings = fn.issues.filter((i) => i.severity === 'warning').length;
      if (fn.issues.length === 0 && !showAll) continue;
      const range = new vscode.Range(fn.startLine, 0, fn.startLine, 0);
      const title =
        fn.issues.length > 0
          ? `⚡ SBLLM: ${fn.issues.length} performance issue${fn.issues.length === 1 ? '' : 's'}${warnings ? '' : ' (minor)'} · ${fn.complexity} — Optimize`
          : `⚡ SBLLM: Optimize (${fn.complexity})`;
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          command: 'sbllmOptimizer.optimizeFunction',
          arguments: [doc.uri, fn.startLine],
          tooltip: fn.issues.map((i) => `• ${i.message}`).join('\n') || 'Run the search-based optimizer on this function',
        }),
      );
    }
    return lenses;
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const ours = ctx.diagnostics.filter((d) => d.source === 'SBLLM');
    if (ours.length === 0) return [];
    const fn = this.functionAt(doc, ours[0].range.start.line);
    if (!fn || !fn.topLevel) return [];
    const action = new vscode.CodeAction(`⚡ Optimize \`${fn.name}\` with SBLLM`, vscode.CodeActionKind.QuickFix);
    action.diagnostics = ours;
    action.command = { title: action.title, command: 'sbllmOptimizer.optimizeFunction', arguments: [doc.uri, fn.startLine] };
    return [action];
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
    this.lensEmitter.dispose();
  }
}
