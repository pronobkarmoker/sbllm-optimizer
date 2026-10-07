import * as vscode from 'vscode';
import path from 'node:path';
import { EvolutionaryOptimizer, type OptimizerResult } from '../core/optimizer/evolutionaryOptimizer.js';
import type { Candidate } from '../core/fitness/types.js';
import { findEnclosingFunctionRange, findEnclosingCppFunctionRange } from '../core/lang/functionRange.js';
import type { LanguageId } from '../core/lang/languageAdapter.js';
import { isAbortError } from '../core/util/abort.js';
import { buildProvider, GEMINI_SECRET_KEY, OPENAI_SECRET_KEY } from './llmProviderFactory.js';
import { DiffContentProvider, SBLLM_DIFF_SCHEME } from './diffContentProvider.js';
import { OptimizationPanel } from './insightsPanel.js';
import { runDiagnosticsCommand } from './diagnostics.js';
import { AnalysisController } from './analysisController.js';
import { HistoryStore, type HistoryRecord } from './historyStore.js';

let diffProvider: DiffContentProvider;
let diffCounter = 0;
let output: vscode.OutputChannel;
let history: HistoryStore;
let analysis: AnalysisController | undefined;

/** The one optimization session the panel is currently showing. Starting a new one cancels the old. */
interface Session {
  runId: number;
  uri: vscode.Uri;
  language: LanguageId;
  functionName: string;
  model: string;
  originalCode: string;
  /** The function's text as it currently is in the document (changes after Apply). */
  currentCode: string;
  optimizer: EvolutionaryOptimizer;
  result: OptimizerResult | null;
  controller: AbortController | null;
  historyId: string;
}

let session: Session | null = null;
let runCounter = 0;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SBLLM Optimizer');
  history = new HistoryStore(context);
  diffProvider = new DiffContentProvider();
  context.subscriptions.push(output, vscode.workspace.registerTextDocumentContentProvider(SBLLM_DIFF_SCHEME, diffProvider));

  const scriptsDir = path.join(context.extensionPath, 'dist', 'python');
  analysis = new AnalysisController(scriptsDir);
  context.subscriptions.push(analysis);

  context.subscriptions.push(
    vscode.commands.registerCommand('sbllmOptimizer.optimizeSelection', () => optimizeCommand(context)),
    vscode.commands.registerCommand('sbllmOptimizer.optimizeFunction', (uri?: vscode.Uri, line?: number) =>
      optimizeCommand(context, uri && typeof line === 'number' ? { uri, line } : undefined),
    ),
    vscode.commands.registerCommand('sbllmOptimizer.analyzeFile', () => analyzeFileCommand()),
    vscode.commands.registerCommand('sbllmOptimizer.showHistory', () => showHistoryCommand()),
    vscode.commands.registerCommand('sbllmOptimizer.cancel', () => session?.controller?.abort()),
    vscode.commands.registerCommand('sbllmOptimizer.applyBest', async () => {
      if (!session?.result?.improved) {
        vscode.window.showInformationMessage('SBLLM: there is no verified optimization to apply.');
        return false;
      }
      return applyCandidate(session, OptimizationPanel.createOrShow(), 'best');
    }),
    vscode.commands.registerCommand('sbllmOptimizer.setGeminiApiKey', () => setSecretCommand(context, GEMINI_SECRET_KEY, 'Gemini')),
    vscode.commands.registerCommand('sbllmOptimizer.setOpenAIApiKey', () => setSecretCommand(context, OPENAI_SECRET_KEY, 'OpenAI')),
    vscode.commands.registerCommand('sbllmOptimizer.diagnoseConnection', () => runDiagnosticsCommand()),
  );
}

export function deactivate(): void {
  session?.controller?.abort();
}

async function setSecretCommand(context: vscode.ExtensionContext, key: string, label: string): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: `Enter your ${label} API key (stored in VS Code's secret storage, never in settings.json)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value) {
    await context.secrets.store(key, value.trim());
    vscode.window.showInformationMessage(`SBLLM: ${label} API key saved.`);
  }
}

function languageOf(doc: vscode.TextDocument): LanguageId | null {
  return doc.languageId === 'python' ? 'python' : doc.languageId === 'cpp' ? 'cpp' : null;
}

function log(msg: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function optimizeCommand(context: vscode.ExtensionContext, target?: { uri: vscode.Uri; line: number }): Promise<void> {
  let editor = vscode.window.activeTextEditor;
  if (target) {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    const pos = new vscode.Position(target.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
  }
  if (!editor) {
    vscode.window.showErrorMessage('SBLLM: open a Python or C++ file first.');
    return;
  }
  const language = languageOf(editor.document);
  if (!language) {
    vscode.window.showErrorMessage('SBLLM supports Python and C++ files.');
    return;
  }

  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      'SBLLM runs your code — and AI-generated variants of it — locally to measure performance. This requires a trusted workspace.',
      'Trust Workspace',
      'Cancel',
    );
    if (choice !== 'Trust Workspace') return;
    await vscode.commands.executeCommand('workbench.action.trustWorkspace');
    if (!vscode.workspace.isTrusted) return;
  }

  const range = resolveTargetRange(editor, language);
  if (!range) {
    vscode.window.showErrorMessage('SBLLM: place your cursor inside a function, or select the function to optimize.');
    return;
  }

  const document = editor.document;
  const defLineText = document.lineAt(range.start.line).text;
  if (/^\s+\S/.test(defLineText)) {
    vscode.window.showErrorMessage(
      'SBLLM optimizes top-level functions only — this looks like a class method or nested function.',
    );
    return;
  }

  const slowCode = document.getText(range);
  // Everything before the target function — imports, constants, earlier helpers — so functions
  // that depend on file-level context can execute. The optimizer strips statements with side
  // effects (I/O, prints, input()) from it before anything runs.
  const contextPrefix = document.getText(new vscode.Range(0, 0, range.start.line, 0));

  let built;
  try {
    built = await buildProvider(context);
  } catch (err) {
    vscode.window.showErrorMessage(`SBLLM: ${(err as Error).message}`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const optimizer = new EvolutionaryOptimizer(built.provider, {
    scriptsDir: path.join(context.extensionPath, 'dist', 'python'),
    language,
    pythonPath: cfg.get<string>('pythonPath'),
    cppCompiler: cfg.get<string>('cppCompiler'),
    patternFile: cfg.get<string>('patternFile')?.trim() || undefined,
  });

  const functionName = optimizer.adapter.extractFunctionName(slowCode) ?? 'function';

  // A new run supersedes whatever was running before.
  session?.controller?.abort();
  const s: Session = {
    runId: ++runCounter,
    uri: document.uri,
    language,
    functionName,
    model: built.label,
    originalCode: slowCode,
    currentCode: slowCode,
    optimizer,
    result: null,
    controller: null,
    historyId: `${Date.now()}-${runCounter}`,
  };
  session = s;

  const panel = OptimizationPanel.createOrShow();
  panel.setCallbacks({
    onApply: (id) => void applyCandidate(s, panel, id),
    onRefine: () => void runSearch(s, panel, 'refine'),
    onShowDiff: (id) => {
      const c = findCandidate(s, id);
      if (c) void showDiff(s, c, id === 'best' ? 'Best' : `#${c.id}`);
    },
    onCancel: () => s.controller?.abort(),
  });
  panel.reset({ functionName, language: language === 'cpp' ? 'C++' : 'Python', model: built.label, slowCode });
  output.clear();
  log(`Optimizing ${functionName} in ${path.basename(document.uri.fsPath)} with ${built.label}`);

  await runSearch(s, panel, 'optimize', contextPrefix);
}

function findCandidate(s: Session, id: number | 'best'): Candidate | null {
  if (!s.result) return null;
  if (id === 'best') return s.result.best;
  return s.result.finalists.find((f) => f.id === id) ?? s.result.history.find((c) => c.id === id) ?? null;
}

/** Runs optimize() or refineFurther() with a cancellable progress notification mirrored into the panel. */
async function runSearch(s: Session, panel: OptimizationPanel, mode: 'optimize' | 'refine', contextPrefix?: string): Promise<void> {
  if (s.controller) return; // already running
  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const options = {
    ns: cfg.get<number>('representativeSamples', 3),
    maxIterations: cfg.get<number>('maxIterations', 4),
    generationNumber: cfg.get<number>('generationNumber', 4),
    minSpeedup: cfg.get<number>('minSpeedup', 1.1),
  };
  const isCurrent = () => session === s;
  const controller = new AbortController();
  s.controller = controller;
  if (mode === 'refine') panel.showRunning('Refining');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: mode === 'optimize' ? `SBLLM: optimizing ${s.functionName}` : `SBLLM: refining ${s.functionName}`,
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      const onProgress = (msg: string) => {
        log(msg);
        if (!isCurrent()) return;
        progress.report({ message: msg });
        panel.appendProgress(msg);
      };
      const onCandidate = (c: Candidate) => {
        if (isCurrent()) panel.addCandidate(c);
      };

      try {
        const result =
          mode === 'optimize'
            ? await s.optimizer.optimize(s.originalCode, { ...options, contextPrefix, onProgress, onCandidate, signal: controller.signal })
            : await s.optimizer.refineFurther({ ...options, onProgress, onCandidate, signal: controller.signal });
        s.result = result;
        await recordHistory(s, result);
        if (!isCurrent()) return;
        panel.showResult(result);
        if (result.improved && result.best) {
          await showDiff(s, result.best, mode === 'optimize' ? 'Best' : 'Best (refined)');
          void vscode.window
            .showInformationMessage(
              `SBLLM: ${s.functionName} is ${result.best.speedup.toFixed(2)}x faster (verified on held-out tests).`,
              'Apply',
            )
            .then((choice) => {
              if (choice === 'Apply' && isCurrent()) void applyCandidate(s, panel, 'best');
            });
        } else {
          void vscode.window.showInformationMessage(
            result.best
              ? `SBLLM: no candidate beat the original by at least ${result.minSpeedup}x.`
              : 'SBLLM: no correct optimized version was found.',
          );
        }
      } catch (err) {
        const cancelled = isAbortError(err, controller.signal);
        const message = cancelled ? 'Cancelled before any candidate was evaluated.' : (err as Error).message;
        log(`Error: ${message}`);
        if (isCurrent()) panel.showError(message);
        if (!cancelled) vscode.window.showErrorMessage(`SBLLM: ${message}`);
      } finally {
        s.controller = null;
      }
    },
  );
}

async function recordHistory(s: Session, r: OptimizerResult): Promise<void> {
  const record: HistoryRecord = {
    id: s.historyId,
    timestamp: new Date().toISOString(),
    file: s.uri.fsPath || s.uri.toString(),
    functionName: s.functionName,
    language: s.language,
    model: s.model,
    improved: r.improved,
    speedup: r.best?.speedup ?? null,
    baselineMs: r.best?.baselineTimeMs ?? r.baselineTimeMs,
    optimizedMs: r.best?.avgTimeMs ?? null,
    candidatesEvaluated: r.history.length,
    iterations: r.iterations.length,
    originalCode: s.originalCode,
    bestCode: r.best?.code ?? null,
    applied: false,
  };
  try {
    await history.add(record);
  } catch (err) {
    log(`Could not save history: ${(err as Error).message}`);
  }
}

/**
 * Replaces the function in the document with the candidate. The target is located by its CURRENT
 * text, not by the range captured when the run started: the user may have edited the file during a
 * minutes-long search, and after one Apply the old range no longer matches the function at all —
 * replacing it blindly is what used to corrupt the file on a second Apply.
 */
async function applyCandidate(s: Session, panel: OptimizationPanel, id: number | 'best'): Promise<boolean> {
  const r = s.result;
  const candidate = findCandidate(s, id);
  if (!r || !candidate) return false;
  const verified = r.finalists.find((f) => f.id === candidate.id);
  if (!verified || verified.acc !== 1 || verified.speedup < r.minSpeedup) {
    vscode.window.showWarningMessage('SBLLM: only candidates verified correct and faster on the held-out tests can be applied.');
    return false;
  }
  if (s.controller) {
    vscode.window.showWarningMessage('SBLLM: wait for the current run to finish (or cancel it) before applying.');
    return false;
  }

  const doc = await vscode.workspace.openTextDocument(s.uri);
  const text = doc.getText();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const normalize = (code: string) => code.replace(/\r\n/g, '\n').replace(/\n/g, eol);

  const locate = (needle: string): number[] => {
    const hits: number[] = [];
    if (!needle) return hits;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push(i);
    return hits;
  };
  let needle = s.currentCode;
  let hits = locate(needle);
  if (hits.length === 0) {
    needle = normalize(s.currentCode);
    hits = locate(needle);
  }
  if (hits.length !== 1) {
    const choice = await vscode.window.showErrorMessage(
      hits.length === 0
        ? `SBLLM: \`${s.functionName}\` was changed since the optimization started, so it can't be replaced safely.`
        : `SBLLM: \`${s.functionName}\` appears more than once in the file, so it can't be replaced safely.`,
      'Copy Optimized Code',
    );
    if (choice) await vscode.env.clipboard.writeText(candidate.code);
    return false;
  }

  const replacement = normalize(candidate.code.replace(/\s+$/, ''));
  const start = doc.positionAt(hits[0]);
  const end = doc.positionAt(hits[0] + needle.length);
  // Keep the original's trailing whitespace (the selection may or may not have ended in a newline).
  const trailing = needle.match(/\s*$/)?.[0] ?? '';
  const edit = new vscode.WorkspaceEdit();
  edit.replace(s.uri, new vscode.Range(start, end), replacement + trailing);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage('SBLLM: the edit could not be applied.');
    return false;
  }
  s.currentCode = replacement + trailing;
  panel.showApplied(candidate.id);
  await history.markApplied(s.historyId).catch(() => {});
  log(`Applied candidate #${candidate.id} to ${s.functionName}.`);
  vscode.window.showInformationMessage(`SBLLM: applied optimized ${s.functionName} (#${candidate.id}). Undo with Ctrl+Z.`);
  return true;
}

async function showDiff(s: Session, candidate: Candidate, label: string): Promise<void> {
  const id = ++diffCounter;
  const ext = s.language === 'cpp' ? 'cpp' : 'py';
  const originalUri = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/session-${id}/original.${ext}`);
  const optimizedUri = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/session-${id}/optimized.${ext}`);
  diffProvider.set(originalUri, s.originalCode);
  diffProvider.set(optimizedUri, candidate.code);
  // preview:false so every diff opens as its own tab instead of silently replacing the previous one.
  await vscode.commands.executeCommand('vscode.diff', originalUri, optimizedUri, `SBLLM: Original ↔ ${label}`, { preview: false });
}

/** Resolves what to optimize: an explicit full-function selection is used as-is; a cursor or partial
 *  selection is widened to the enclosing function. */
function resolveTargetRange(editor: vscode.TextEditor, language: LanguageId): vscode.Range | null {
  const document = editor.document;
  const selection = editor.selection;
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

  if (!selection.isEmpty) {
    const selectedText = document.getText(selection).trim();
    if (language === 'python' && /^(@[\s\S]*?\n\s*)?(async\s+)?def\s/.test(selectedText)) return selection;
    if (language === 'cpp') {
      // Accept a selection only if it is exactly one complete function definition.
      const sub = findEnclosingCppFunctionRange(selectedText.split('\n'), 0);
      if (sub && sub.startLine === 0 && sub.endLine === selectedText.split('\n').length - 1) return selection;
    }
  }

  const anchorLine = selection.isEmpty ? selection.active.line : selection.start.line;
  const found =
    language === 'python' ? findEnclosingFunctionRange(lines, anchorLine) : findEnclosingCppFunctionRange(lines, anchorLine);
  if (!found) return null;
  return new vscode.Range(found.startLine, 0, found.endLine, document.lineAt(found.endLine).text.length);
}

async function analyzeFileCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !languageOf(editor.document) || !analysis) {
    vscode.window.showErrorMessage('SBLLM: open a Python or C++ file to analyze.');
    return;
  }
  const result = await analysis.analyze(editor.document);
  if (!result) return;
  if (result.error) {
    vscode.window.showWarningMessage(`SBLLM: could not analyze this file — ${result.error}`);
    return;
  }
  type Item = vscode.QuickPickItem & { line: number; fnLine: number; topLevel: boolean };
  const items: Item[] = [];
  for (const fn of result.functions) {
    for (const i of fn.issues) {
      items.push({
        label: `$(warning) ${fn.name}: ${i.message}`,
        description: `line ${i.line + 1} · ${fn.complexity}`,
        detail: i.suggestion,
        line: i.line,
        fnLine: fn.startLine,
        topLevel: fn.topLevel,
      });
    }
  }
  if (items.length === 0) {
    vscode.window.showInformationMessage(`SBLLM: no inefficiency patterns found in ${result.functions.length} function(s).`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `SBLLM: ${items.length} potential performance issue(s)`,
    placeHolder: 'Select an issue to jump to it',
    matchOnDetail: true,
  });
  if (!pick) return;
  const pos = new vscode.Position(pick.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  if (pick.topLevel) {
    const go = await vscode.window.showInformationMessage('Optimize this function with SBLLM?', 'Optimize');
    if (go) await vscode.commands.executeCommand('sbllmOptimizer.optimizeFunction', editor.document.uri, pick.fnLine);
  }
}

async function showHistoryCommand(): Promise<void> {
  const records = await history.list();
  if (records.length === 0) {
    vscode.window.showInformationMessage('SBLLM: no optimization runs recorded yet.');
    return;
  }
  type Item = vscode.QuickPickItem & { record?: HistoryRecord; clear?: boolean };
  const items: Item[] = records.map((r) => ({
    label: `${r.improved ? '$(check)' : '$(circle-slash)'} ${r.functionName}`,
    description: r.improved && r.speedup ? `${r.speedup.toFixed(2)}x faster${r.applied ? ' · applied' : ''}` : 'no improvement',
    detail: `${new Date(r.timestamp).toLocaleString()} · ${path.basename(r.file)} · ${r.model} · ${r.candidatesEvaluated} candidates`,
    record: r,
  }));
  items.push({ label: '$(trash) Clear history', clear: true });
  const pick = await vscode.window.showQuickPick(items, { title: 'SBLLM optimization history', matchOnDetail: true });
  if (!pick) return;
  if (pick.clear) {
    await history.clear();
    vscode.window.showInformationMessage('SBLLM: history cleared.');
    return;
  }
  const r = pick.record!;
  if (!r.bestCode) {
    vscode.window.showInformationMessage('SBLLM: that run did not produce a correct candidate.');
    return;
  }
  const id = ++diffCounter;
  const ext = r.language === 'cpp' ? 'cpp' : 'py';
  const a = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/history-${id}/original.${ext}`);
  const b = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/history-${id}/optimized.${ext}`);
  diffProvider.set(a, r.originalCode);
  diffProvider.set(b, r.bestCode);
  await vscode.commands.executeCommand('vscode.diff', a, b, `SBLLM history: ${r.functionName}`, { preview: false });
  const copy = await vscode.window.showInformationMessage('Copy the optimized code to the clipboard?', 'Copy');
  if (copy) await vscode.env.clipboard.writeText(r.bestCode);
}
