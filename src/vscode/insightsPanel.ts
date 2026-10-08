import * as vscode from 'vscode';
import type { OptimizerResult } from '../core/optimizer/evolutionaryOptimizer.js';
import type { Candidate } from '../core/fitness/types.js';

export interface PanelCallbacks {
  onApply: (candidateId: number | 'best') => void;
  onRefine: () => void;
  onShowDiff: (candidateId: number | 'best') => void;
  onCompare: (candidateId: number | 'best') => void;
  onCancel: () => void;
}

export interface SessionInfo {
  functionName: string;
  language: string;
  model: string;
  slowCode: string;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * The "Optimization Insights" WebView: live search progress, the execution comparison (original vs
 * optimized time per call), the verified finalists, the per-iteration search trace (representative
 * samples and the similar/different patterns used), and the Apply / Refine / Diff / Cancel actions.
 * Diffs are rendered by VS Code's native diff editor, not here.
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
    this.panel.webview.onDidReceiveMessage((msg: { command: string; id?: number | 'best' }) => {
      if (!this.callbacks) return;
      if (msg.command === 'apply') this.callbacks.onApply(msg.id ?? 'best');
      else if (msg.command === 'refine') this.callbacks.onRefine();
      else if (msg.command === 'showDiff') this.callbacks.onShowDiff(msg.id ?? 'best');
      else if (msg.command === 'compare') this.callbacks.onCompare(msg.id ?? 'best');
      else if (msg.command === 'cancel') this.callbacks.onCancel();
    });
    this.panel.webview.html = renderShell(this.panel.webview.cspSource);
  }

  setCallbacks(callbacks: PanelCallbacks): void {
    this.callbacks = callbacks;
  }

  reset(info: SessionInfo): void {
    this.post({ command: 'reset', info });
  }

  appendProgress(message: string): void {
    this.post({ command: 'progress', message });
  }

  addCandidate(candidate: Candidate): void {
    this.post({ command: 'candidate', candidate });
  }

  showRunning(label: string): void {
    this.post({ command: 'running', label });
  }

  showResult(result: OptimizerResult): void {
    this.post({ command: 'result', result });
  }

  showApplied(id: number): void {
    this.post({ command: 'applied', id });
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
    --ok: var(--vscode-charts-green, #3fb950);
    --bad: var(--vscode-charts-red, #f85149);
    --run: var(--vscode-charts-yellow, #d29922);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 0 16px 16px; font-size: 13px; }
  #app { max-width: 760px; margin: 0 auto; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 14px 0 10px; z-index: 5;
           border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 8px; }
  .pill { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; color: #fff; white-space: nowrap; }
  .pill-pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill-running { background: var(--run); color: #000; }
  .pill-ok { background: var(--ok); }
  .pill-bad { background: var(--bad); }
  .pill-neutral { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px;
          background: var(--vscode-sideBar-background, transparent); }
  .hidden { display: none !important; }
  .headline { font-size: 22px; font-weight: 700; }
  .headline .unit { font-size: 13px; font-weight: 500; color: var(--muted); margin-left: 4px; }
  .compare { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; align-items: center; margin-top: 10px; font-size: 12px; }
  .bar { height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; }
  .bar > div { height: 100%; }
  .bar .orig { background: var(--muted); }
  .bar .opt { background: var(--ok); }
  .note { color: var(--muted); font-size: 12px; margin-top: 8px; }
  pre.text { white-space: pre-wrap; font-family: inherit; margin: 0; line-height: 1.5; }
  .log { list-style: none; margin: 0; padding: 0; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace);
         color: var(--muted); max-height: 180px; overflow-y: auto; }
  .log li { padding: 1px 0; }
  .log li::before { content: "› "; opacity: 0.6; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-weight: 600; color: var(--muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
  td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.err { color: var(--bad); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr.iter-row td { color: var(--muted); font-weight: 600; background: var(--vscode-editor-background); }
  .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0 4px; }
  .link:hover { text-decoration: underline; }
  .link:disabled { opacity: 0.4; cursor: default; text-decoration: none; }
  .actions { position: sticky; bottom: 0; display: flex; gap: 8px; padding: 10px 0; background: var(--vscode-editor-background); }
  .btn { flex: 1; padding: 7px 10px; border-radius: 4px; border: none; font-size: 13px; cursor: pointer; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:not(:disabled):hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                   border: 1px solid var(--border); }
  .empty { color: var(--muted); text-align: center; padding: 28px 0; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="title-row">
      <h1 id="title">⚡ SBLLM Optimization Insights</h1>
      <span id="status" class="pill pill-pending">Idle</span>
    </div>
    <div id="subtitle" class="sub"></div>
  </header>

  <div id="empty" class="empty">Run <strong>SBLLM: Optimize Selected Code</strong>, or click a ⚡ CodeLens above a function.</div>

  <section id="summary" class="card hidden">
    <div id="headline" class="headline"></div>
    <div id="compare" class="compare"></div>
    <div id="summary-note" class="note"></div>
  </section>

  <section id="progress-card" class="card hidden">
    <h2>Progress</h2>
    <ul id="log" class="log"></ul>
  </section>

  <section id="explain-card" class="card hidden">
    <h2>Why this is faster</h2>
    <pre id="explain" class="text"></pre>
  </section>

  <section id="finalists-card" class="card hidden">
    <h2>Verified finalists (held-out private tests)</h2>
    <table><thead><tr><th>#</th><th>Public</th><th>Private</th><th>Status</th><th></th></tr></thead><tbody id="finalists"></tbody></table>
  </section>

  <section id="trace-card" class="card hidden">
    <h2>Search trace</h2>
    <table><thead><tr><th>Iter</th><th>Representative samples</th><th>Similar pattern</th><th>Different pattern</th><th>New</th></tr></thead><tbody id="trace"></tbody></table>
  </section>

  <section id="history-card" class="card hidden">
    <h2>All candidates</h2>
    <table><thead><tr><th>#</th><th>Iter</th><th>Result</th><th>Speedup</th><th></th></tr></thead><tbody id="history"></tbody></table>
  </section>

  <footer class="actions">
    <button id="apply" class="btn btn-primary" disabled>Apply to Editor</button>
    <button id="refine" class="btn btn-secondary" disabled>Refine Further</button>
    <button id="compare" class="btn btn-secondary" disabled>Compare</button>
    <button id="diff" class="btn btn-secondary" disabled>Show Diff</button>
    <button id="cancel" class="btn btn-secondary hidden">Cancel</button>
  </footer>
</div>

<script nonce="${scriptNonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = { running: false, result: null, rows: new Map(), applied: new Set() };

  function setStatus(kind, label) { $('status').className = 'pill pill-' + kind; $('status').textContent = label; }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms >= 100) return ms.toFixed(0) + ' ms';
    if (ms >= 1) return ms.toFixed(2) + ' ms';
    if (ms >= 0.001) return (ms * 1000).toFixed(1) + ' µs';
    return (ms * 1e6).toFixed(0) + ' ns';
  }
  function fmtX(x) { return (Math.round(x * 100) / 100).toFixed(2) + 'x'; }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function linkBtn(label, onClick, disabled) {
    const b = el('button', label, 'link'); b.disabled = !!disabled; b.addEventListener('click', onClick); return b;
  }

  function setRunning(running, label) {
    state.running = running;
    $('cancel').classList.toggle('hidden', !running);
    if (running) {
      setStatus('running', label || 'Running');
      $('apply').disabled = true; $('refine').disabled = true; $('diff').disabled = true; $('compare').disabled = true;
      show('progress-card');
    }
  }

  function candidateRow(c) {
    const tr = el('tr');
    tr.appendChild(el('td', '#' + c.id, 'num'));
    tr.appendChild(el('td', c.iteration === 0 ? 'seed' : String(c.iteration), 'num'));
    const res = el('td');
    if (c.acc === 1) res.appendChild(el('span', 'Correct', 'pill pill-ok'));
    else {
      res.appendChild(el('span', 'Incorrect', 'pill pill-bad'));
      if (c.error) { const e = el('div', c.error, 'err'); e.title = c.error; res.appendChild(e); res.className = 'err'; }
    }
    tr.appendChild(res);
    tr.appendChild(el('td', c.acc === 1 ? fmtX(c.speedup) : '—', 'num'));
    const act = el('td');
    act.appendChild(linkBtn('Compare', () => vscode.postMessage({ command: 'compare', id: c.id }), state.running));
    act.appendChild(linkBtn('Diff', () => vscode.postMessage({ command: 'showDiff', id: c.id })));
    tr.appendChild(act);
    return tr;
  }

  function addCandidate(c) {
    show('history-card');
    const row = candidateRow(c);
    const old = state.rows.get(c.id);
    if (old) old.replaceWith(row); else $('history').appendChild(row);
    state.rows.set(c.id, row);
  }

  function renderSummary(r) {
    show('summary');
    const compare = $('compare'); compare.innerHTML = '';
    const best = r.best;
    if (r.improved && best) {
      setStatus('ok', 'Optimized');
      $('headline').innerHTML = '';
      $('headline').appendChild(document.createTextNode(fmtX(best.speedup)));
      $('headline').appendChild(el('span', 'faster (verified on held-out tests)', 'unit'));
      const orig = best.baselineTimeMs, opt = best.avgTimeMs;
      if (orig && opt) {
        const max = Math.max(orig, opt);
        const row = (label, v, cls) => {
          compare.appendChild(el('div', label));
          const bar = el('div', undefined, 'bar'); const fill = el('div', undefined, cls);
          fill.style.width = Math.max(2, (v / max) * 100) + '%'; bar.appendChild(fill); compare.appendChild(bar);
          compare.appendChild(el('div', fmtMs(v) + ' / call', 'num'));
        };
        row('Original', orig, 'orig');
        row('Optimized #' + best.id, opt, 'opt');
      }
    } else if (best) {
      setStatus('neutral', 'No improvement');
      $('headline').textContent = 'No meaningful speedup found';
      compare.appendChild(el('div', 'The best correct candidate (#' + best.id + ') measured ' + fmtX(best.speedup) +
        ', below the ' + r.minSpeedup + 'x threshold — not offered, so measurement noise is never applied as an "optimization".'));
      compare.style.display = 'block';
    } else {
      setStatus('bad', 'No correct candidate');
      $('headline').textContent = 'No correct optimized version found';
      const passedSearch = r.history.filter((c) => c.acc === 1).length;
      if (passedSearch > 0) {
        const reason = r.finalists.length && r.finalists[0].error ? r.finalists[0].error : 'output did not match';
        compare.appendChild(el('div',
          passedSearch + ' candidate(s) passed the search tests, but none passed the held-out tests (' + reason +
          '). Nothing is applied unless it passes both. Try Refine Further.'));
      } else {
        compare.appendChild(el('div', 'Every candidate failed the tests. Try Refine Further, or a stronger model.'));
      }
      compare.style.display = 'block';
    }
    if (r.improved) compare.style.display = '';
    const stop = { converged: 'converged', 'max-iterations': 'reached the iteration limit', cancelled: 'cancelled', 'model-error': 'stopped after model errors' }[r.stopReason] || r.stopReason;
    $('summary-note').textContent =
      r.history.length + ' candidate(s) over ' + r.iterations.length + ' iteration(s); search ' + stop + '. ' +
      r.publicCount + ' public / ' + r.privateCount + ' private test case(s).' +
      (r.contextSkipped && r.contextSkipped.length ? ' Skipped ' + r.contextSkipped.length + ' top-level statement(s) with side effects.' : '') +
      (r.randomCount ? ' Final check: ' + r.randomCount + ' random tests.' : '') +
      (r.testStrength ? ' Test strength: the tests catch ' + r.testStrength.killed + ' of ' + r.testStrength.mutants + ' deliberately planted bugs' +
        (r.testStrength.killed < r.testStrength.mutants ? ' — treat the result with extra care.' : '.') : '');
  }

  function renderFinalists(r) {
    const body = $('finalists'); body.innerHTML = '';
    if (!r.finalists.length) { hide('finalists-card'); return; }
    show('finalists-card');
    r.finalists.forEach((f) => {
      const tr = el('tr');
      tr.appendChild(el('td', '#' + f.id, 'num'));
      tr.appendChild(el('td', fmtX(f.publicSpeedup), 'num'));
      tr.appendChild(el('td', f.acc === 1 ? fmtX(f.speedup) : '—', 'num'));
      const st = el('td');
      const eligible = f.acc === 1 && f.speedup >= r.minSpeedup;
      st.appendChild(el('span', f.acc !== 1 ? 'Failed private' : eligible ? 'Verified' : 'Too small', 'pill ' + (f.acc !== 1 ? 'pill-bad' : eligible ? 'pill-ok' : 'pill-neutral')));
      if (f.acc !== 1 && f.error) { const e = el('div', f.error, 'err'); e.title = f.error; st.appendChild(e); }
      tr.appendChild(st);
      const act = el('td');
      act.appendChild(linkBtn('Compare', () => vscode.postMessage({ command: 'compare', id: f.id }), state.running));
      act.appendChild(linkBtn('Diff', () => vscode.postMessage({ command: 'showDiff', id: f.id })));
      act.appendChild(linkBtn(state.applied.has(f.id) ? 'Applied' : 'Apply', () => vscode.postMessage({ command: 'apply', id: f.id }), !eligible || state.running));
      tr.appendChild(act);
      body.appendChild(tr);
    });
  }

  function renderTrace(r) {
    const body = $('trace'); body.innerHTML = '';
    if (!r.iterations.length) { hide('trace-card'); return; }
    show('trace-card');
    r.iterations.forEach((it) => {
      const tr = el('tr');
      tr.appendChild(el('td', String(it.iteration), 'num'));
      tr.appendChild(el('td', it.representativeIds.map((i) => '#' + i).join(', ')));
      tr.appendChild(el('td', it.similarPattern || '—'));
      tr.appendChild(el('td', it.differentPattern || '—'));
      tr.appendChild(el('td', it.newCandidateIds.map((i) => '#' + i).join(', ') || '—'));
      body.appendChild(tr);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'reset') {
      hide('empty'); hide('summary'); hide('explain-card'); hide('finalists-card'); hide('trace-card'); hide('history-card');
      $('log').innerHTML = ''; $('history').innerHTML = ''; state.rows.clear(); state.result = null; state.applied.clear();
      $('title').textContent = '⚡ ' + msg.info.functionName;
      $('subtitle').textContent = msg.info.language + ' · ' + msg.info.model;
      setRunning(true, 'Running');
    } else if (msg.command === 'running') {
      setRunning(true, msg.label);
    } else if (msg.command === 'progress') {
      const li = el('li', msg.message); $('log').appendChild(li); $('log').scrollTop = $('log').scrollHeight;
    } else if (msg.command === 'candidate') {
      addCandidate(msg.candidate);
    } else if (msg.command === 'result') {
      const r = msg.result; state.result = r;
      setRunning(false);
      renderSummary(r);
      if (r.best && r.best.explanation) { $('explain').textContent = r.best.explanation; show('explain-card'); } else hide('explain-card');
      r.history.forEach(addCandidate);
      renderFinalists(r);
      renderTrace(r);
      $('apply').disabled = !r.improved;
      $('refine').disabled = false;
      $('diff').disabled = !r.best;
      $('compare').disabled = !r.best;
    } else if (msg.command === 'applied') {
      state.applied.add(msg.id);
      if (state.result) renderFinalists(state.result);
    } else if (msg.command === 'error') {
      setRunning(false);
      setStatus('bad', 'Failed');
      $('log').appendChild(el('li', 'Error: ' + msg.message));
      $('refine').disabled = !state.result;
      $('apply').disabled = !(state.result && state.result.improved);
    }
  });

  $('apply').addEventListener('click', () => vscode.postMessage({ command: 'apply', id: 'best' }));
  $('refine').addEventListener('click', () => vscode.postMessage({ command: 'refine' }));
  $('diff').addEventListener('click', () => vscode.postMessage({ command: 'showDiff', id: 'best' }));
  $('compare').addEventListener('click', () => vscode.postMessage({ command: 'compare', id: 'best' }));
  $('cancel').addEventListener('click', () => { $('cancel').disabled = true; vscode.postMessage({ command: 'cancel' }); setTimeout(() => { $('cancel').disabled = false; }, 1500); });
})();
</script>
</body>
</html>`;
}
