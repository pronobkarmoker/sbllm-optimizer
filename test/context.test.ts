import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { estimateTokens, signaturesOnly } from '../src/core/prompt/contextBudget.js';
import { buildInitialPrompt, buildIterationPrompt } from '../src/core/prompt/goCotPromptBuilder.js';
import { sliceCppContext } from '../src/core/lang/cpp/cppSource.js';
import { PythonAdapter } from '../src/core/lang/pythonAdapter.js';
import { OllamaProvider } from '../src/core/llm/ollamaProvider.js';
import type { Candidate } from '../src/core/fitness/types.js';
import { HAS_PYTHON, SCRIPTS_DIR } from './helpers.js';

const cand = (id: number, code: string, acc: number): Candidate => ({
  id, code, acc, speedup: acc === 1 ? 5 : 1, avgTimeMs: acc === 1 ? 1 : null, baselineTimeMs: acc === 1 ? 5 : null, iteration: 0,
  error: acc === 1 ? undefined : 'return value did not match the original',
});

test('Python context slicing keeps only what the function uses, transitively', { skip: !HAS_PYTHON && 'python not available' }, async () => {
  const context = [
    'import os', 'import math', 'from collections import Counter',
    'LIMIT = 10', 'UNUSED = 99',
    'def helper(x):', '    return math.sqrt(x) + LIMIT',
    'def unrelated():', '    return os.getcwd()',
    'class Big:', '    pass',
  ].join('\n');
  const target = 'def f(xs):\n    return [helper(x) for x in xs]';
  const s = await new PythonAdapter(SCRIPTS_DIR).sliceContext(context, target);
  assert.match(s.code, /def helper/);
  assert.match(s.code, /import math/, 'transitive: helper uses math');
  assert.match(s.code, /LIMIT = 10/, 'transitive: helper uses LIMIT');
  assert.doesNotMatch(s.code, /unrelated|UNUSED|Counter|class Big|import os/);
  assert.equal(s.kept, 3);
  assert.equal(s.total, 8);
});

test('C++ context slicing drops unused functions but keeps globals and directives', () => {
  const context = '#include <vector>\nconst int K = 3;\nint sq(int x) { return x * x; }\nint cube(int x) { return sq(x) * x; }\nint unused(int y) { return y + 1; }\nint main() { return 0; }\n';
  const s = sliceCppContext(context, 'int f(int n) { return cube(n) + K; }');
  assert.match(s.code, /#include <vector>/);
  assert.match(s.code, /const int K = 3;/);
  assert.match(s.code, /int cube/);
  assert.match(s.code, /int sq/, 'transitive: cube calls sq');
  assert.doesNotMatch(s.code, /unused/);
});

test('signatures-only context keeps declarations and drops bodies', () => {
  const py = signaturesOnly('python', 'import math\nX = 1\n@dec\ndef a(x):\n    y = x\n    return y\n\nclass B:\n    def m(self):\n        return 1\n');
  assert.match(py, /def a\(x\):\n    \.\.\./);
  assert.doesNotMatch(py, /y = x/);
  assert.match(py, /import math/);
  const cpp = signaturesOnly('cpp', 'int a(int x) {\n  return x * 2;\n}\nconst int K = 1;');
  assert.match(cpp, /int a\(int x\) \{ \/\* \.\.\. \*\/ \}/);
  assert.match(cpp, /const int K = 1;/);
});

test('prompt budget: parts are trimmed in priority order and the function is never cut', () => {
  const fn = 'def f(xs):\n    return sorted(xs)[0]';
  const bigContext = Array.from({ length: 300 }, (_, i) => `def helper_${i}(x):\n    return x + ${i}`).join('\n');
  const versions = [cand(0, fn.replace('sorted(xs)[0]', 'min(xs)'), 1), cand(1, 'def f(xs):\n' + '    pass\n'.repeat(200), 0)];
  const pattern = { pattern: { id: 'p', description: 'Use min().', slow: 'def g(a):\n    return sorted(a)[0]', fast: 'def g(a):\n    return min(a)', source: 'curated' as const }, diff: '- sorted\n+ min', score: 1 };

  const full = buildIterationPrompt('python', fn, versions, { similar: pattern, different: null }, bigContext);
  assert.equal(full.trimmed, undefined, 'no budget, no trimming');

  const budget = 900;
  const p = buildIterationPrompt('python', fn, versions, { similar: pattern, different: null }, bigContext, budget);
  assert.ok(p.trimmed && p.trimmed.length > 0);
  assert.equal(p.trimmed![0], 'file context reduced to signatures', 'context is trimmed first');
  assert.ok(estimateTokens(p.system! + p.user) <= budget || p.trimmed!.some((t) => /over budget/.test(t)));
  assert.match(p.user, /def f\(xs\):\n    return sorted\(xs\)\[0\]/, 'the function itself is intact');
  assert.match(p.user, /min\(xs\)/, 'the best version is intact');

  const init = buildInitialPrompt('python', fn, bigContext, 600);
  assert.ok(init.trimmed && init.trimmed.length > 0);
  assert.match(init.user, /return sorted\(xs\)\[0\]/);
});

test('Ollama requests always carry an explicit context window', async () => {
  let body: any = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const p = new OllamaProvider({ model: 'm', host: `http://127.0.0.1:${port}` });
    assert.equal(p.contextWindow, 8192);
    await p.generate({ user: 'hi' });
    assert.equal(body.options.num_ctx, 8192);
    const q = new OllamaProvider({ model: 'm', host: `http://127.0.0.1:${port}`, contextWindow: 16384 });
    await q.generate({ user: 'hi' });
    assert.equal(body.options.num_ctx, 16384);
  } finally {
    server.close();
  }
});
