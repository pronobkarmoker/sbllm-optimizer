import * as vscode from 'vscode';
import path from 'node:path';
import { EvolutionaryOptimizer, type OptimizerResult } from '../core/optimizer/evolutionaryOptimizer.js';
import type { Candidate } from '../core/fitness/types.js';
import { findEnclosingFunctionRange } from '../core/lang/functionRange.js';
import { buildProvider, GEMINI_SECRET_KEY } from './llmProviderFactory.js';
import { DiffContentProvider, SBLLM_DIFF_SCHEME } from './diffContentProvider.js';
import { OptimizationPanel } from './insightsPanel.js';

let diffProvider: DiffContentProvider;
let diffCounter = 0;

export function activate(context: vscode.ExtensionContext): void {
  diffProvider = new DiffContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SBLLM_DIFF_SCHEME, diffProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('sbllmOptimizer.setGeminiApiKey', () => setGeminiApiKeyCommand(context)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sbllmOptimizer.optimizeSelection', () => optimizeSelectionCommand(context)),
  );
}

export function deactivate(): void {}

async function setGeminiApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Gemini API key (stored securely, never in settings.json)',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await context.secrets.store(GEMINI_SECRET_KEY, key);
    vscode.window.showInformationMessage('SBLLM: Gemini API key saved.');
  }
}

async function optimizeSelectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('SBLLM: open a Python file first.');
    return;
  }
  if (editor.document.languageId !== 'python') {
    vscode.window.showErrorMessage('SBLLM currently supports Python only.');
    return;
  }

  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      'SBLLM runs your code — and AI-generated variants of it — locally to measure performance. ' +
        'This requires a trusted workspace.',
      'Trust Workspace',
      'Cancel',
    );
    if (choice !== 'Trust Workspace') return;
    await vscode.commands.executeCommand('workbench.action.trustWorkspace');
    if (!vscode.workspace.isTrusted) return;
  }

  const range = resolveTargetRange(editor);
  if (!range) {
    vscode.window.showErrorMessage('SBLLM: place your cursor inside a function, or select the code to optimize.');
    return;
  }

  const defLineText = editor.document.lineAt(range.start.line).text;
  const defIndent = defLineText.match(/^(\s*)def\s/)?.[1]?.length ?? 0;
  if (defIndent > 0) {
    vscode.window.showErrorMessage(
      'SBLLM currently supports top-level functions only — this looks like a class method or ' +
        'nested function, which isn\'t supported yet.',
    );
    return;
  }

  const slowCode = editor.document.getText(range);
  // Everything before the target function — imports, module-level constants, earlier helper
  // functions — so functions that depend on file-level context (very common in real code) can
  // actually execute instead of failing with a NameError. Deliberately excludes anything AFTER
  // the function (e.g. driver/invocation code): that's typically one-off script logic, not
  // something the function itself depends on, and re-running it on every evaluation would be
  // wasteful and could have unwanted side effects (printing, file I/O, etc.).
  const contextPrefix = editor.document.getText(new vscode.Range(0, 0, range.start.line, 0));

  let provider;
  try {
    provider = await buildProvider(context);
  } catch (err) {
    vscode.window.showErrorMessage(`SBLLM: ${(err as Error).message}`);
    return;
  }

  const scriptsDir = path.join(context.extensionPath, 'dist', 'python');
  const optimizer = new EvolutionaryOptimizer(provider, { scriptsDir });

  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const ns = cfg.get<number>('representativeSamples', 3);
  const maxIterations = cfg.get<number>('maxIterations', 4);
  const generationNumber = cfg.get<number>('generationNumber', 4);

  const panel = OptimizationPanel.createOrShow();
  let latestResult: OptimizerResult | null = null;

  panel.setCallbacks({
    onApply: () => {
      if (latestResult) void applyToEditor(editor, range, latestResult.best.code);
    },
    onRefine: () => {
      void runWithProgress(panel, 'SBLLM: refining further', async (onProgress, signal) => {
        panel.showRefining();
        const result = await optimizer.refineFurther({ ns, maxIterations, generationNumber, onProgress, signal });
        latestResult = result;
        panel.showResult(result);
        await showDiffForCandidate(slowCode, result.best, 'Best (refined)');
      });
    },
    onShowDiff: (index) => {
      if (!latestResult) return;
      const candidate = index === 'best' ? latestResult.best : latestResult.history[index];
      if (candidate) void showDiffForCandidate(slowCode, candidate, index === 'best' ? 'Best' : `#${index}`);
    },
  });

  panel.reset(slowCode);

  await runWithProgress(panel, 'SBLLM: optimizing selected code', async (onProgress, signal) => {
    const result = await optimizer.optimize(slowCode, { ns, maxIterations, generationNumber, onProgress, signal, contextPrefix });
    latestResult = result;
    panel.showResult(result);
    await showDiffForCandidate(slowCode, result.best, 'Best');
  });
}

/** Wraps an optimize/refine run with a cancellable VS Code progress notification whose messages are
 *  mirrored into the insights panel's live log. */
async function runWithProgress(
  panel: OptimizationPanel,
  title: string,
  run: (onProgress: (msg: string) => void, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      const onProgress = (msg: string) => {
        progress.report({ message: msg });
        panel.appendProgress(msg);
      };

      try {
        await run(onProgress, controller.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        panel.showError(message);
        vscode.window.showErrorMessage(`SBLLM: ${message}`);
      }
    },
  );
}

async function applyToEditor(editor: vscode.TextEditor, range: vscode.Range, code: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, range, code.endsWith('\n') ? code : `${code}\n`);
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage('SBLLM: optimized code applied.');
}

async function showDiffForCandidate(originalCode: string, candidate: Candidate, label: string): Promise<void> {
  const id = ++diffCounter;
  const originalUri = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/session-${id}/original.py`);
  const optimizedUri = vscode.Uri.parse(`${SBLLM_DIFF_SCHEME}:/session-${id}/optimized.py`);
  diffProvider.set(originalUri, originalCode);
  diffProvider.set(optimizedUri, candidate.code);
  // preview:false so every diff opens as its own persistent tab — with preview:true, VS Code
  // silently replaces the previous diff tab's content, which made it look like clicking
  // "Show Diff" / "View diff" for a different candidate did nothing at all.
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    optimizedUri,
    `SBLLM: Original ↔ ${label}`,
    { preview: false },
  );
}

/** Resolves what to optimize: an explicit full-function selection is used as-is; a cursor or partial
 *  selection is widened to the enclosing `def` block (via the VS-Code-free findEnclosingFunctionRange). */
function resolveTargetRange(editor: vscode.TextEditor): vscode.Range | null {
  const document = editor.document;
  const selection = editor.selection;

  if (!selection.isEmpty) {
    const selectedText = document.getText(selection).trim();
    if (selectedText.startsWith('def ')) {
      return selection;
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

  const anchorLine = selection.isEmpty ? selection.active.line : selection.start.line;
  const found = findEnclosingFunctionRange(lines, anchorLine);

  if (!found) {
    return selection.isEmpty ? null : selection;
  }

  const { startLine, endLine } = found;
  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}
