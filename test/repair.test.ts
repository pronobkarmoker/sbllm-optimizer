import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDegenerateRepetition } from '../src/core/llm/llmProvider.js';
import { repairCandidate } from '../src/core/optimizer/candidateRepair.js';
import { PythonAdapter } from '../src/core/lang/pythonAdapter.js';
import { CppAdapter } from '../src/core/lang/cppAdapter.js';
import { HAS_PYTHON, SCRIPTS_DIR } from './helpers.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('repetition detector flags a real looping reply, but not normal replies or code', () => {
  const loop = readFileSync(path.join(fixtures, 'qwen-repetition-loop.txt'), 'utf8');
  assert.ok(isDegenerateRepetition(loop), 'the captured loop must be detected');
  // Detection while streaming: it must already fire on an early prefix of the loop.
  assert.ok(isDegenerateRepetition(loop.slice(0, 2600)));
  const ok = readdirSync(fixtures).filter((f) => f.startsWith('qwen-ok-'));
  assert.ok(ok.length > 0);
  for (const f of ok) {
    const text = readFileSync(path.join(fixtures, f), 'utf8');
    for (let end = 400; end <= text.length; end += 400) {
      assert.ok(!isDegenerateRepetition(text.slice(0, end)), `false positive on ${f} at ${end}`);
    }
  }
  const code = 'int f(std::vector<int>& v) {\n' + '    v.push_back(1);\n'.repeat(5) + '    return 0;\n}';
  assert.ok(!isDegenerateRepetition(code));
});

test('repair: a renamed C++ target function is renamed back (including recursive calls)', async () => {
  const code = 'int helper(int x) { return x; }\nlong long count_ways(int n) { return n < 2 ? 1 : count_ways(n - 1) + helper(n); }';
  const r = await repairCandidate(code, { adapter: new CppAdapter(), funcName: 'ways', arity: 1, contextPrefix: '' });
  assert.match(r.code, /long long ways\(int n\)/);
  assert.match(r.code, /ways\(n - 1\)/);
  assert.match(r.code, /int helper\(int x\)/, 'helpers keep their names');
  assert.equal(r.notes.length, 1);
});

test('repair leaves correctly named code alone', async () => {
  const code = 'bool f(int x) { return x > 0; }';
  const r = await repairCandidate(code, { adapter: new CppAdapter(), funcName: 'f', arity: 1, contextPrefix: '' });
  assert.equal(r.code, code);
  assert.deepEqual(r.notes, []);
});

test('repair (Python): rename + missing stdlib imports', { skip: !HAS_PYTHON && 'python not available' }, async () => {
  const adapter = new PythonAdapter(SCRIPTS_DIR);
  const code = '@lru_cache(maxsize=None)\ndef check_dups(nums):\n    c = Counter(nums)\n    return any(v > 1 for v in c.values())';
  const r = await repairCandidate(code, { adapter, funcName: 'has_duplicate', arity: 1, contextPrefix: 'import os\n' });
  assert.match(r.code, /^from collections import Counter\nfrom functools import lru_cache\n/);
  assert.match(r.code, /def has_duplicate\(nums\)/);
  assert.equal(r.notes.length, 2);

  // Names already imported by the file context, or defined locally, are not re-imported.
  const ctx = await repairCandidate('def f(xs):\n    deque = list\n    return Counter(deque(xs))', {
    adapter,
    funcName: 'f',
    arity: 1,
    contextPrefix: 'from collections import Counter\n',
  });
  assert.deepEqual(ctx.notes, []);

  // bisect used as a function vs. as a module.
  const fn = await adapter.repairImports('def f(a, x):\n    return bisect(a, x)', '');
  assert.deepEqual(fn.added, ['from bisect import bisect']);
  const mod = await adapter.repairImports('def f(a, x):\n    return bisect.bisect_left(a, x)', '');
  assert.deepEqual(mod.added, ['import bisect']);
});
