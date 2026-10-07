// Runs INSIDE the VS Code extension host (loaded by runTest.mjs). Exercises the real UI wiring:
// activation, diagnostics, CodeLens, quick fixes, a full optimization through the commands (against
// a local mock OpenAI-compatible server), Apply, the insights panel, the diff view and history.
const vscode = require('vscode');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.SBLLM_TEST_WORKSPACE;
const USER_DATA = process.env.SBLLM_TEST_USER_DATA;

const FAST = [
  'def has_duplicate(numbers):',
  '    seen = set()',
  '    for n in numbers:',
  '        if n in seen:',
  '            return True',
  '        seen.add(n)',
  '    return False',
].join('\n');
const INPUTS = JSON.stringify({
  inputs: [[[1, 2, 3]], [[1, 2, 1]], [[]], [[5]], [[7, 7]], [[3, 1, 4, 1, 5]], [[10, 20, 30, 40]], [[-1, -2, -3, -1]]],
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what, fn, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Minimal OpenAI-compatible Chat Completions server returning scripted answers. */
function startMockLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      const system = (json.messages || []).find((m) => m.role === 'system')?.content || '';
      const content = system.includes('generate test inputs')
        ? INPUTS
        : JSON.stringify({ analysis: 'nested loop is O(n^2)', opportunities: 'use a set', explanation: 'Track seen values in a set: O(n).', code: FAST });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    results.push(`  ✗ ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
    throw err;
  }
}

async function run() {
  const ext = vscode.extensions.getExtension('sbllm-optimizer-dev.sbllm-optimizer');
  try {
    await step('extension activates and registers its commands', async () => {
      assert.ok(ext, 'extension not found');
      await ext.activate();
      const cmds = await vscode.commands.getCommands(true);
      for (const c of ['optimizeSelection', 'optimizeFunction', 'analyzeFile', 'showHistory', 'applyBest', 'compareBest', 'cancel', 'setOpenAIApiKey']) {
        assert.ok(cmds.includes(`sbllmOptimizer.${c}`), `missing command ${c}`);
      }
    });

    const pyUri = vscode.Uri.file(path.join(WORKSPACE, 'inefficient.py'));
    await step('Python diagnostics appear for the inefficient example', async () => {
      const doc = await vscode.workspace.openTextDocument(pyUri);
      await vscode.window.showTextDocument(doc);
      const diags = await waitFor('python diagnostics', () => {
        const d = vscode.languages.getDiagnostics(pyUri).filter((x) => x.source === 'SBLLM');
        return d.length >= 6 ? d : null;
      });
      const codes = new Set(diags.map((d) => d.code));
      for (const k of ['list-membership-in-loop', 'loop-invariant-computation', 'string-concat-in-loop', 'list-pop-front', 'exponential-recursion', 'sort-for-min-max']) {
        assert.ok(codes.has(k), `missing diagnostic ${k}`);
      }
    });

    await step('CodeLens offers "Optimize" on flagged functions only', async () => {
      const lenses = await waitFor('code lenses', async () => {
        const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pyUri);
        return l && l.length ? l : null;
      });
      const titles = lenses.map((l) => l.command && l.command.title);
      assert.ok(titles.every((t) => t.startsWith('⚡ SBLLM')), titles.join(' | '));
      assert.equal(lenses.length, 6, `expected 6 lenses (stairs_memo is clean), got ${lenses.length}: ${titles.join(' | ')}`);
      assert.ok(titles.some((t) => t.includes('O(n^2)')));
      assert.ok(titles.some((t) => t.includes('exponential')));
    });

    await step('quick fix offers "Optimize with SBLLM" on a diagnostic', async () => {
      const diag = vscode.languages.getDiagnostics(pyUri).find((d) => d.code === 'list-pop-front');
      const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', pyUri, diag.range);
      assert.ok(actions.some((a) => /Optimize `drain` with SBLLM/.test(a.title)), actions.map((a) => a.title).join(' | '));
    });

    await step('C++ diagnostics and CodeLens appear for the C++ example', async () => {
      const cppUri = vscode.Uri.file(path.join(WORKSPACE, 'inefficient.cpp'));
      const doc = await vscode.workspace.openTextDocument(cppUri);
      await vscode.window.showTextDocument(doc);
      await waitFor('cpp diagnostics', () => vscode.languages.getDiagnostics(cppUri).filter((x) => x.source === 'SBLLM').length >= 5);
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', cppUri);
      assert.equal(lenses.length, 4);
    });

    const { server, requests, port } = await startMockLLM();
    try {
      const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
      const G = vscode.ConfigurationTarget.Global;
      await cfg.update('llmProvider', 'openai', G);
      await cfg.update('openaiBaseUrl', `http://127.0.0.1:${port}/v1`, G);
      await cfg.update('openaiModel', 'mock-model', G);
      await cfg.update('generationNumber', 2, G);
      await cfg.update('maxIterations', 1, G);

      const dupUri = vscode.Uri.file(path.join(WORKSPACE, 'has_duplicate.py'));
      const dupDoc = await vscode.workspace.openTextDocument(dupUri);
      await vscode.window.showTextDocument(dupDoc);
      const defLine = dupDoc.getText().split('\n').findIndex((l) => l.startsWith('def has_duplicate'));

      await step('optimizeFunction runs the full search through the extension (mock LLM)', async () => {
        await vscode.commands.executeCommand('sbllmOptimizer.optimizeFunction', dupUri, defLine);
        assert.ok(requests.length >= 3, `expected LLM calls, got ${requests.length}`);
        assert.ok(requests.some((r) => (r.messages || []).some((m) => /\[Crossover\]/.test(m.content || ''))), 'GO-COT prompt was not used');
      });

      await step('insights panel and the side-by-side Compare view open for the result', async () => {
        const tabLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
        // Webview tabs are registered asynchronously after the panel is created.
        await waitFor('Compare tab', () => tabLabels().some((l) => /^SBLLM Compare: has_duplicate #\d+$/.test(l)), 15000).catch(() => {
          throw new Error('Compare tab not open; tabs: ' + tabLabels().join(' | '));
        });
        assert.ok(tabLabels().includes('SBLLM Optimization Insights'), tabLabels().join(' | '));
      });

      await step('Compare Best Result runs the syntactic + semantic comparison', async () => {
        const ok = await vscode.commands.executeCommand('sbllmOptimizer.compareBest');
        assert.equal(ok, true);
      });

      await step('Apply Best Result replaces the function in the document', async () => {
        const ok = await vscode.commands.executeCommand('sbllmOptimizer.applyBest');
        assert.equal(ok, true, 'applyBest returned false');
        const text = dupDoc.getText();
        assert.ok(text.includes('seen = set()'), text);
        assert.equal((text.match(/def has_duplicate/g) || []).length, 1);
        assert.ok(text.startsWith('# Demo 1'), 'comment header above the function must be untouched');
      });

      await step('applying a second time does not corrupt the file', async () => {
        const before = dupDoc.getText();
        await vscode.commands.executeCommand('sbllmOptimizer.applyBest');
        assert.equal(dupDoc.getText(), before);
      });

      await step('the run was saved to history', async () => {
        const file = path.join(USER_DATA, 'User', 'globalStorage', 'sbllm-optimizer-dev.sbllm-optimizer', 'optimization-history.json');
        const records = await waitFor('history file', () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null), 10000);
        assert.equal(records[0].functionName, 'has_duplicate');
        assert.equal(records[0].improved, true);
        assert.equal(records[0].applied, true);
        assert.ok(records[0].speedup >= 1.1, `speedup ${records[0].speedup}`);
      });
    } finally {
      server.close();
    }
  } finally {
    console.log('\nSBLLM VS Code integration tests:\n' + results.join('\n') + '\n');
  }
}

module.exports = { run };
