import * as vscode from 'vscode';
import type { ComparisonReport } from '../core/optimizer/evolutionaryOptimizer.js';

export interface CompareCallbacks {
  onApply: (candidateId: number) => void;
  onNativeDiff: (candidateId: number) => void;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * "Compare" view: original and optimized code side by side (syntax-highlighted, aligned, with
 * removed/added/changed lines marked), plus how similar they are — syntactically (token and
 * AST-structural similarity, lines changed) and semantically (identical behaviour on every test
 * input, measured by running both) — with per-input outputs and timings and the complexity of each.
 * Opens in the main editor area, where there is room for two columns.
 */
export class ComparePanel {
  private static current: ComparePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private callbacks: CompareCallbacks | null = null;
  private ready = false;
  private pending: unknown = null;

  static show(report: ComparisonReport, callbacks: CompareCallbacks, canApply: boolean): ComparePanel {
    let inst = ComparePanel.current;
    if (inst) {
      inst.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'sbllmOptimizer.compare',
        'SBLLM Compare',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      inst = new ComparePanel(panel);
      ComparePanel.current = inst;
    }
    inst.callbacks = callbacks;
    inst.panel.title = `SBLLM Compare: ${report.functionName} #${report.candidateId}`;
    inst.post({ command: 'show', report, canApply });
    return inst;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      ComparePanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg: { command: string; id?: number }) => {
      if (msg.command === 'ready') {
        this.ready = true;
        if (this.pending) void this.panel.webview.postMessage(this.pending);
        this.pending = null;
        return;
      }
      if (!this.callbacks || typeof msg.id !== 'number') return;
      if (msg.command === 'apply') this.callbacks.onApply(msg.id);
      else if (msg.command === 'diff') this.callbacks.onNativeDiff(msg.id);
    });
    this.panel.webview.html = renderShell(this.panel.webview.cspSource);
  }

  showApplied(): void {
    this.post({ command: 'applied' });
  }

  private post(message: unknown): void {
    // The webview may not have loaded yet on first open; deliver once it reports ready.
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.pending = message;
  }
}

function renderShell(cspSource: string): string {
  const n = nonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<title>SBLLM Compare</title>
<style>
  :root {
    --ok: var(--vscode-charts-green, #3fb950);
    --bad: var(--vscode-charts-red, #f85149);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --add-bg: rgba(63, 185, 80, 0.16);
    --del-bg: rgba(248, 81, 73, 0.16);
    --chg-bg: rgba(210, 153, 34, 0.14);
    --kw: #c586c0; --str: #ce9178; --num: #b5cea8; --com: #6a9955; --fn: #dcdcaa; --ty: #4ec9b0;
  }
  body.vscode-light { --kw: #af00db; --str: #a31515; --num: #098658; --com: #008000; --fn: #795e26; --ty: #267f99; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 16px 20px 24px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 20px 0 8px; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--vscode-sideBar-background, transparent); }
  .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .card .big { font-size: 22px; font-weight: 700; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
  .card .note { font-size: 12px; color: var(--muted); }
  .meter { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin: 6px 0 2px; }
  .meter > div { height: 100%; background: var(--vscode-progressBar-background, var(--ok)); }
  .row2 { display: flex; justify-content: space-between; font-size: 12px; margin-top: 6px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  .actions { display: flex; gap: 8px; margin-top: 14px; }
  .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; font-size: 13px; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--border); }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-bottom: 6px; flex-wrap: wrap; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .code { border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace);
          font-size: var(--vscode-editor-font-size, 13px); }
  .grid { display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); min-width: 760px; }
  .hdr { position: sticky; top: 0; padding: 6px 10px; font-family: var(--vscode-font-family); font-size: 12px; font-weight: 600;
         background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); border-bottom: 1px solid var(--border); }
  .ln { padding: 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground, var(--muted)); user-select: none; min-width: 36px; }
  .src { padding: 0 10px; white-space: pre; }
  .sep { border-left: 1px solid var(--border); }
  .removed { background: var(--del-bg); } .added { background: var(--add-bg); } .changed { background: var(--chg-bg); }
  .empty { background: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(128,128,128,.08) 4px, rgba(128,128,128,.08) 8px); }
  .t-kw { color: var(--kw); } .t-str { color: var(--str); } .t-num { color: var(--num); } .t-com { color: var(--com); font-style: italic; }
  .t-fn { color: var(--fn); } .t-ty { color: var(--ty); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 5px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
  td.mono { font-family: var(--vscode-editor-font-family, monospace); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .tbar { width: 120px; }
  .tbar div { height: 5px; border-radius: 2px; margin: 2px 0; }
  .tbar .o { background: var(--muted); } .tbar .c { background: var(--ok); }
  .why { color: var(--bad); font-size: 11px; }
  .wait { color: var(--muted); padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<div id="root"><div class="wait">Comparing…</div></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function pct(x) { return x === null || x === undefined ? '—' : Math.round(x * 100) + '%'; }
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms >= 100) return ms.toFixed(0) + ' ms';
    if (ms >= 1) return ms.toFixed(2) + ' ms';
    if (ms >= 0.001) return (ms * 1000).toFixed(1) + ' µs';
    return (ms * 1e6).toFixed(0) + ' ns';
  }
  function fmtX(x) { return x >= 100 ? Math.round(x).toLocaleString() + 'x' : x.toFixed(2) + 'x'; }

  // ---- minimal syntax highlighter (per line; builds spans with textContent, never innerHTML) ----
  const KW = {
    python: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')),
    cpp: new Set('auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while'.split(' ')),
  };
  const TY = {
    python: new Set('int float str bool list dict set tuple frozenset bytes object range len sum min max sorted enumerate zip map filter any all abs print'.split(' ')),
    cpp: new Set('std vector string map set unordered_map unordered_set pair deque queue stack size_t int64_t uint64_t array bitset'.split(' ')),
  };
  function highlight(line, lang) {
    const frag = document.createDocumentFragment();
    const re = lang === 'cpp'
      ? /(\\/\\/.*$)|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_]\\w*)|(\\s+)|(.)/g
      : /(#.*$)|("""|'''|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_]\\w*)|(\\s+)|(.)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      let cls = null;
      if (m[1]) cls = 't-com';
      else if (m[2]) cls = 't-str';
      else if (m[3]) cls = 't-num';
      else if (m[4]) {
        const w = m[4];
        if (KW[lang].has(w)) cls = 't-kw';
        else if (TY[lang].has(w)) cls = 't-ty';
        else if (line.slice(re.lastIndex).match(/^\\s*\\(/)) cls = 't-fn';
      }
      if (cls) frag.appendChild(el('span', m[0], cls)); else frag.appendChild(document.createTextNode(m[0]));
      if (m[0].length === 0) re.lastIndex++;
    }
    return frag;
  }

  function card(label, big, note, cls) {
    const c = el('div', undefined, 'card');
    c.appendChild(el('div', label, 'label'));
    const b = el('div', big, 'big' + (cls ? ' ' + cls : ''));
    c.appendChild(b);
    if (note) c.appendChild(el('div', note, 'note'));
    return c;
  }
  function meterRow(c, label, value) {
    const r = el('div', undefined, 'row2'); r.appendChild(el('span', label)); r.appendChild(el('span', pct(value))); c.appendChild(r);
    const m = el('div', undefined, 'meter'); const f = el('div'); f.style.width = Math.round((value || 0) * 100) + '%'; m.appendChild(f); c.appendChild(m);
  }

  function render(r, canApply) {
    root.textContent = '';
    const lang = r.language;
    root.appendChild(el('h1', 'Original ↔ Optimized #' + r.candidateId + ' — ' + r.functionName));
    root.appendChild(el('div', (lang === 'cpp' ? 'C++' : 'Python') + ' · similarity of the optimized version to the original, by structure and by behaviour', 'sub'));

    // ---- metric cards ----
    const cards = el('div', undefined, 'cards');
    const sem = r.semantic;
    const allSame = sem.matched === sem.total;
    cards.appendChild(card('Semantic similarity', pct(sem.equivalence),
      sem.matched + ' / ' + sem.total + ' test inputs behave identically (return value, printed output, argument state) — measured by running both',
      allSame ? 'ok' : 'bad'));

    const syn = card('Syntactic similarity', pct(r.syntactic.tokenSimilarity), null);
    meterRow(syn, 'Token similarity', r.syntactic.tokenSimilarity);
    meterRow(syn, 'Structural (AST) similarity', r.syntactic.structuralSimilarity);
    cards.appendChild(syn);

    const s = r.syntactic;
    cards.appendChild(card('Lines', '+' + s.linesAdded + '  −' + s.linesRemoved + '  ~' + s.linesChanged,
      s.linesUnchanged + ' unchanged · ' + s.linesAdded + ' added · ' + s.linesRemoved + ' removed · ' + s.linesChanged + ' changed'));

    cards.appendChild(card('Complexity (static estimate)',
      (r.complexity.original || '?') + ' → ' + (r.complexity.candidate || '?'),
      r.complexity.original && r.complexity.candidate && r.complexity.original !== r.complexity.candidate
        ? 'Asymptotic improvement' : 'Same asymptotic class (constant-factor change)'));

    cards.appendChild(card('Speed', r.speedup ? fmtX(r.speedup) + ' faster' : '—',
      r.speedup ? 'Total time over all ' + sem.total + ' inputs, original vs optimized, measured in the same process'
                : 'Not computed: the versions do not behave identically on every input', r.speedup ? 'ok' : null));
    root.appendChild(cards);

    const actions = el('div', undefined, 'actions');
    const apply = el('button', 'Apply this version', 'btn btn-primary');
    apply.id = 'apply-btn';
    apply.disabled = !canApply;
    if (!canApply) apply.title = 'Only versions verified correct and faster on the held-out tests can be applied.';
    apply.addEventListener('click', () => vscode.postMessage({ command: 'apply', id: r.candidateId }));
    const diff = el('button', 'Open in VS Code diff editor', 'btn btn-secondary');
    diff.addEventListener('click', () => vscode.postMessage({ command: 'diff', id: r.candidateId }));
    actions.appendChild(apply); actions.appendChild(diff);
    root.appendChild(actions);

    // ---- side by side ----
    root.appendChild(el('h2', 'Side by side'));
    const legend = el('div', undefined, 'legend');
    [['var(--del-bg)', 'removed'], ['var(--add-bg)', 'added'], ['var(--chg-bg)', 'changed']].forEach(([c, t]) => {
      const s = el('span'); const sw = el('span', undefined, 'sw'); sw.style.background = c; s.appendChild(sw); s.appendChild(document.createTextNode(t)); legend.appendChild(s);
    });
    root.appendChild(legend);
    const code = el('div', undefined, 'code');
    const grid = el('div', undefined, 'grid');
    const h1 = el('div', 'Original', 'hdr'); h1.style.gridColumn = '1 / span 2';
    const h2 = el('div', 'Optimized #' + r.candidateId, 'hdr sep'); h2.style.gridColumn = '3 / span 2';
    grid.appendChild(h1); grid.appendChild(h2);
    r.rows.forEach((row) => {
      const kindL = row.kind === 'same' ? '' : row.left ? row.kind === 'added' ? '' : row.kind : 'empty';
      const kindR = row.kind === 'same' ? '' : row.right ? row.kind === 'removed' ? '' : row.kind : 'empty';
      const lnL = el('div', row.left ? String(row.left.no) : '', 'ln ' + kindL);
      const srcL = el('div', undefined, 'src ' + kindL);
      if (row.left) srcL.appendChild(highlight(row.left.text, lang));
      const lnR = el('div', row.right ? String(row.right.no) : '', 'ln sep ' + kindR);
      const srcR = el('div', undefined, 'src ' + kindR);
      if (row.right) srcR.appendChild(highlight(row.right.text, lang));
      grid.appendChild(lnL); grid.appendChild(srcL); grid.appendChild(lnR); grid.appendChild(srcR);
    });
    code.appendChild(grid);
    root.appendChild(code);

    // ---- per-input behaviour ----
    root.appendChild(el('h2', 'Behaviour on each test input'));
    const table = el('table');
    const thead = el('thead'); const hr = el('tr');
    ['#', 'Set', 'Input', 'Original', 'Optimized', 'Same?', 'Original', 'Optimized', ''].forEach((t) => hr.appendChild(el('th', t)));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el('tbody');
    sem.cases.forEach((c, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', String(i + 1), 'num'));
      const set = el('td'); set.appendChild(el('span', c.stress ? 'stress' : c.split === 'public' ? 'search' : 'held-out', 'badge')); tr.appendChild(set);
      const inp = el('td', c.input, 'mono'); inp.title = c.input; tr.appendChild(inp);
      const ex = el('td', c.expected, 'mono'); ex.title = c.expected; tr.appendChild(ex);
      const ac = el('td', c.actual === null ? '—' : c.actual, 'mono'); ac.title = c.actual || ''; tr.appendChild(ac);
      const same = el('td', c.match ? '✓' : '✗', c.match ? 'ok' : 'bad');
      if (!c.match && c.reason) { same.appendChild(el('div', c.reason, 'why')); }
      tr.appendChild(same);
      tr.appendChild(el('td', fmtMs(c.originalMs), 'num'));
      tr.appendChild(el('td', fmtMs(c.candidateMs), 'num'));
      const bars = el('td', undefined, 'tbar');
      const max = Math.max(c.originalMs || 0, c.candidateMs || 0);
      if (max > 0) {
        const o = el('div', undefined, 'o'); o.style.width = Math.max(2, ((c.originalMs || 0) / max) * 100) + '%';
        const cc = el('div', undefined, 'c'); cc.style.width = Math.max(2, ((c.candidateMs || 0) / max) * 100) + '%';
        o.title = 'original'; cc.title = 'optimized';
        bars.appendChild(o); bars.appendChild(cc);
      }
      tr.appendChild(bars);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'show') render(msg.report, msg.canApply);
    else if (msg.command === 'applied') {
      const b = document.getElementById('apply-btn');
      if (b) { b.textContent = 'Applied ✓'; b.disabled = true; }
    }
  });
  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
}
