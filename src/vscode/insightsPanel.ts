import * as vscode from 'vscode';
import type { OptimizerResult } from '../core/optimizer/evolutionaryOptimizer.js';

export interface PanelCallbacks {
  onApply: () => void;
  onRefine: () => void;
  onShowDiff: (index: number | 'best') => void;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * The "Optimization Insights" WebView from ARCHITECTURE.md §8: explanation, per-iteration history,
 * and the Apply / Refine Further / Show Diff actions. Deliberately does NOT render a diff itself —
 * that's the native VS Code diff editor's job; this panel is the narrative and controls around it.
 */
export class OptimizationPanel {
  private static current: OptimizationPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private callbacks: PanelCallbacks | null = null;

  static createOrShow(): OptimizationPanel {
    if (OptimizationPanel.current) {
      OptimizationPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return OptimizationPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'sbllmOptimizer.insights',
      'SBLLM Optimization Insights',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new OptimizationPanel(panel);
    OptimizationPanel.current = instance;
    return instance;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      OptimizationPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg: { command: string; index?: number | 'best' }) => {
      if (!this.callbacks) return;
      if (msg.command === 'apply') this.callbacks.onApply();
      else if (msg.command === 'refine') this.callbacks.onRefine();
      else if (msg.command === 'showDiff') this.callbacks.onShowDiff(msg.index ?? 'best');
    });
    this.panel.webview.html = renderShell(this.panel.webview.cspSource);
  }

  setCallbacks(callbacks: PanelCallbacks): void {
    this.callbacks = callbacks;
  }

  reset(slowCode: string): void {
    this.post({ command: 'reset', slowCode });
  }

  appendProgress(message: string): void {
    this.post({ command: 'progress', message });
  }

  showRefining(): void {
    this.post({ command: 'refining' });
  }

  showResult(result: OptimizerResult): void {
    this.post({ command: 'result', result });
  }

  showError(message: string): void {
    this.post({ command: 'error', message });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }
}

function renderShell(cspSource: string): string {
  const scriptNonce = nonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
<title>SBLLM Optimization Insights</title>
<style>
  :root {
    --pill-correct-bg: var(--vscode-charts-green, #3fb950);
    --pill-incorrect-bg: var(--vscode-charts-red, #f85149);
    --pill-running-bg: var(--vscode-charts-yellow, #d29922);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 0 16px 16px;
  }
  #app { max-width: 720px; margin: 0 auto; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 16px 0 12px; z-index: 5; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
       color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  .pill { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; color: #fff; white-space: nowrap; }
  .pill-pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill-running { background: var(--pill-running-bg); color: #000; }
  .pill-correct { background: var(--pill-correct-bg); }
  .pill-incorrect { background: var(--pill-incorrect-bg); }
  .speedup-row { margin-top: 10px; }
  .speedup-value { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .speedup-value .unit { font-size: 13px; font-weight: 500; color: var(--vscode-descriptionForeground); margin-left: 4px; }
  .speedup-bar-track { height: 6px; border-radius: 3px; background: var(--vscode-panel-border); overflow: hidden; }
  .speedup-bar-fill { height: 100%; background: var(--pill-correct-bg); width: 0%; transition: width 0.4s ease; }
  .card { background: var(--vscode-sideBar-background, transparent); border: 1px solid var(--vscode-panel-border);
          border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .hidden { display: none !important; }
  #explanation-text { white-space: pre-wrap; font-size: 13px; line-height: 1.55; margin: 0; }
  .progress-log { list-style: none; margin: 0; padding: 0; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace);
                  color: var(--vscode-descriptionForeground); max-height: 160px; overflow-y: auto; }
  .progress-log li { padding: 2px 0; }
  .progress-log li::before { content: "› "; opacity: 0.6; }
  .history-list { display: flex; flex-direction: column; gap: 6px; }
  .history-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px;
                 background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .history-row .idx { font-weight: 600; opacity: 0.6; width: 22px; }
  .history-row .meta { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .history-row .err { color: var(--pill-incorrect-bg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .history-row .speedup { font-weight: 600; }
  .history-row .view-link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer;
                             font-size: 12px; padding: 2px 6px; }
  .history-row .view-link:hover { text-decoration: underline; }
  .actions { position: sticky; bottom: 0; display: flex; gap: 8px; padding: 12px 0; background: var(--vscode-editor-background); }
  .btn { flex: 1; padding: 8px 12px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; font-weight: 500; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                   border: 1px solid var(--vscode-panel-border); }
  .btn-secondary:not(:disabled):hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .empty-state { color: var(--vscode-descriptionForeground); font-size: 13px; text-align: center; padding: 24px 0; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="title-row">
      <h1>⚡ SBLLM Optimization Insights</h1>
      <span id="status-pill" class="pill pill-pending">Idle</span>
    </div>
    <div id="speedup-row" class="speedup-row hidden">
      <div class="speedup-value" id="speedup-value">—</div>
      <div class="speedup-bar-track"><div class="speedup-bar-fill" id="speedup-bar"></div></div>
    </div>
  </header>

  <div id="empty-state" class="empty-state">Run <strong>SBLLM: Optimize Selected Code</strong> to get started.</div>

  <section id="progress-section" class="card hidden">
    <h2>Progress</h2>
    <ul id="progress-log" class="progress-log"></ul>
  </section>

  <section id="explanation-section" class="card hidden">
    <h2>Why this is faster</h2>
    <p id="explanation-text"></p>
  </section>

  <section id="history-section" class="card hidden">
    <h2>Search history</h2>
    <div id="history-list" class="history-list"></div>
  </section>

  <footer class="actions">
    <button id="apply-btn" class="btn btn-primary" disabled>Apply to Editor</button>
    <button id="refine-btn" class="btn btn-secondary" disabled>Refine Further</button>
    <button id="diff-btn" class="btn btn-secondary" disabled>Show Diff</button>
  </footer>
</div>

<script nonce="${scriptNonce}">
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    statusPill: document.getElementById('status-pill'),
    speedupRow: document.getElementById('speedup-row'),
    speedupValue: document.getElementById('speedup-value'),
    speedupBar: document.getElementById('speedup-bar'),
    emptyState: document.getElementById('empty-state'),
    progressSection: document.getElementById('progress-section'),
    progressLog: document.getElementById('progress-log'),
    explanationSection: document.getElementById('explanation-section'),
    explanationText: document.getElementById('explanation-text'),
    historySection: document.getElementById('history-section'),
    historyList: document.getElementById('history-list'),
    applyBtn: document.getElementById('apply-btn'),
    refineBtn: document.getElementById('refine-btn'),
    diffBtn: document.getElementById('diff-btn'),
  };

  function setStatus(kind, label) {
    el.statusPill.className = 'pill pill-' + kind;
    el.statusPill.textContent = label;
  }

  function show(node) { node.classList.remove('hidden'); }
  function hide(node) { node.classList.add('hidden'); }

  function renderSpeedup(speedup) {
    show(el.speedupRow);
    const rounded = Math.round(speedup * 100) / 100;
    el.speedupValue.innerHTML = rounded + '<span class="unit">x ' + (rounded >= 1 ? 'faster' : 'vs. original') + '</span>';
    const pct = Math.max(4, Math.min(100, (rounded / 10) * 100));
    el.speedupBar.style.width = pct + '%';
    el.speedupBar.style.background = rounded >= 1 ? 'var(--pill-correct-bg)' : 'var(--pill-incorrect-bg)';
  }

  function renderHistory(history) {
    el.historyList.innerHTML = '';
    history.forEach(function (c, i) {
      const row = document.createElement('div');
      row.className = 'history-row';

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = '#' + i;
      row.appendChild(idx);

      const badge = document.createElement('span');
      badge.className = 'pill ' + (c.acc === 1 ? 'pill-correct' : 'pill-incorrect');
      badge.textContent = c.acc === 1 ? 'Correct' : 'Incorrect';
      row.appendChild(badge);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const speedupLine = document.createElement('div');
      speedupLine.className = 'speedup';
      speedupLine.textContent = (c.speedup !== null ? Math.round(c.speedup * 100) / 100 : '—') + 'x';
      meta.appendChild(speedupLine);
      if (c.error) {
        const errLine = document.createElement('div');
        errLine.className = 'err';
        errLine.title = c.error;
        errLine.textContent = c.error;
        meta.appendChild(errLine);
      }
      row.appendChild(meta);

      const viewBtn = document.createElement('button');
      viewBtn.className = 'view-link';
      viewBtn.textContent = 'View diff';
      viewBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'showDiff', index: i });
      });
      row.appendChild(viewBtn);

      el.historyList.appendChild(row);
    });
    show(el.historySection);
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;

    if (msg.command === 'reset') {
      hide(el.emptyState);
      setStatus('running', 'Running');
      el.progressLog.innerHTML = '';
      show(el.progressSection);
      hide(el.explanationSection);
      hide(el.historySection);
      hide(el.speedupRow);
      el.applyBtn.disabled = true;
      el.refineBtn.disabled = true;
      el.diffBtn.disabled = true;
    } else if (msg.command === 'progress') {
      const li = document.createElement('li');
      li.textContent = msg.message;
      el.progressLog.appendChild(li);
      el.progressLog.scrollTop = el.progressLog.scrollHeight;
    } else if (msg.command === 'refining') {
      setStatus('running', 'Refining');
      el.applyBtn.disabled = true;
      el.refineBtn.disabled = true;
      el.diffBtn.disabled = true;
      show(el.progressSection);
    } else if (msg.command === 'result') {
      const r = msg.result;
      setStatus(r.best.acc === 1 ? 'correct' : 'incorrect', r.best.acc === 1 ? 'Correct' : 'Incorrect');
      renderSpeedup(r.best.speedup);
      el.explanationText.textContent = r.best.explanation || '(no explanation returned for this candidate)';
      show(el.explanationSection);
      renderHistory(r.history);
      el.applyBtn.disabled = r.best.acc !== 1;
      el.refineBtn.disabled = false;
      el.diffBtn.disabled = false;
    } else if (msg.command === 'error') {
      setStatus('incorrect', 'Failed');
      const li = document.createElement('li');
      li.textContent = 'Error: ' + msg.message;
      el.progressLog.appendChild(li);
      el.refineBtn.disabled = true;
    }
  });

  el.applyBtn.addEventListener('click', function () { vscode.postMessage({ command: 'apply' }); });
  el.refineBtn.addEventListener('click', function () { vscode.postMessage({ command: 'refine' }); });
  el.diffBtn.addEventListener('click', function () { vscode.postMessage({ command: 'showDiff', index: 'best' }); });
})();
</script>
</body>
</html>`;
}
