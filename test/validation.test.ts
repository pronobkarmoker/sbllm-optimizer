import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DifferentialTestOracle } from '../src/core/fitness/testOracle/differential.js';
import { buildRandomInputs, cppMutants } from '../src/core/fitness/testOracle/testStrength.js';
import { PythonAdapter } from '../src/core/lang/pythonAdapter.js';
import { CppAdapter } from '../src/core/lang/cppAdapter.js';
import type { LLMProvider } from '../src/core/llm/llmProvider.js';
import { HAS_GXX, HAS_PYTHON, SCRIPTS_DIR } from './helpers.js';

const noPy = !HAS_PYTHON && 'python not available';
const fixedInputs = (inputs: unknown[][]): LLMProvider => ({ id: 'fixed', generate: async () => ({ text: JSON.stringify({ inputs }) }) });

test('random inputs follow the observed shapes and include duplicates, sorted and empty lists', () => {
  const inputs = buildRandomInputs([[[3, 1, 2]], [[10, 20]], [[]]], 100);
  assert.equal(inputs.length, 100);
  const lists = inputs.map((e) => e[0] as number[]);
  assert.ok(lists.every((l) => Array.isArray(l) && l.every((x) => Number.isInteger(x))));
  assert.ok(lists.some((l) => l.length === 0));
  assert.ok(lists.some((l) => new Set(l).size < l.length), 'some lists contain duplicates');
  assert.ok(lists.some((l) => l.length > 3 && l.every((x, i) => i === 0 || l[i - 1] <= x)), 'some lists are sorted');
  assert.deepEqual(buildRandomInputs([[[1, 2]]], 5), buildRandomInputs([[[1, 2]]], 5), 'deterministic');
});

test('C++ mutants: operators in code are swapped, strings and comments are not touched', () => {
  const code = 'bool f(int a, int b) {\n  // a == b in a comment\n  const char* s = "a < b";\n  return a == b && a < b + 1;\n}';
  const ms = cppMutants(code, 'f', 10);
  assert.ok(ms.length >= 3);
  for (const m of ms) {
    assert.match(m.code, /\/\/ a == b in a comment/);
    assert.match(m.code, /"a < b"/);
  }
  assert.ok(ms.some((m) => m.code.includes('a != b')));
});

test('inputs on which the original raises are kept: candidates must raise too', { skip: noPy, timeout: 600_000 }, async () => {
  const slow = 'def average(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total / len(xs)';
  const logs: string[] = [];
  const oracle = await DifferentialTestOracle.build(
    fixedInputs([[[1, 2, 3]], [[]], [[4]], [[2, 2]], [[5, 1, 9]]]),
    new PythonAdapter(SCRIPTS_DIR),
    slow,
    { onProgress: (m) => logs.push(m) },
  );
  assert.ok(logs.some((l) => /Kept 1 input\(s\) on which the original raises \(ZeroDivisionError\)/.test(l)), logs.join('\n'));
  const swallows = 'def average(xs):\n    return sum(xs) / len(xs) if xs else 0';
  const raises = 'def average(xs):\n    return sum(xs) / len(xs)';
  const pub = [await oracle.evaluatePublic(swallows), await oracle.evaluatePrivate(swallows)];
  assert.ok(pub.some((f) => f.acc < 1 && /original raises ZeroDivisionError/.test(f.error ?? '')), JSON.stringify(pub));
  assert.equal((await oracle.evaluatePublic(raises)).acc, 1);
  assert.equal((await oracle.evaluatePrivate(raises)).acc, 1);
});

test('a non-deterministic function is rejected up front', { skip: noPy, timeout: 600_000 }, async () => {
  const slow = 'import random\ndef noisy(xs):\n    return [x + random.random() for x in xs]';
  await assert.rejects(
    DifferentialTestOracle.build(fixedInputs([[[1]], [[2, 3]], [[4, 5, 6]], [[7]]]), new PythonAdapter(SCRIPTS_DIR), slow),
    /different results for the same input/,
  );
});

test('test strength: a bug the generated tests miss is caught by a random input, which is promoted', { skip: noPy, timeout: 600_000 }, async () => {
  // The generated inputs never reach the boundary x == 10, so `x < 10` -> `x <= 10` slips through them.
  const slow = 'def clamp(x):\n    if x < 10:\n        return x\n    return 10';
  const logs: string[] = [];
  const oracle = await DifferentialTestOracle.build(fixedInputs([[1], [2], [3], [-4]]), new PythonAdapter(SCRIPTS_DIR), slow, {
    onProgress: (m) => logs.push(m),
  });
  const s = oracle.testStrength!;
  assert.ok(s, logs.join('\n'));
  assert.ok(s.mutants >= 2);
  assert.ok(s.promotedInputs >= 1, `expected a promoted random input: ${JSON.stringify(s)}`);
  assert.ok(s.killed > s.killedInitially);
  assert.ok(logs.some((l) => /Test strength:/.test(l)));
});

test('random testing catches a candidate that passes the search tests', { skip: noPy, timeout: 600_000 }, async () => {
  const slow = 'def has_duplicate(numbers):\n    for i in range(len(numbers)):\n        for j in range(len(numbers)):\n            if i != j and numbers[i] == numbers[j]:\n                return True\n    return False';
  const oracle = await DifferentialTestOracle.build(fixedInputs([[[]], [[1]], [[1, 2, 3]], [[5, 6]]]), new PythonAdapter(SCRIPTS_DIR), slow);
  // Only checks adjacent pairs — wrong whenever duplicates aren't next to each other.
  const adjacentOnly = 'def has_duplicate(numbers):\n    return any(numbers[i] == numbers[i + 1] for i in range(len(numbers) - 1))';
  const rnd = await oracle.evaluateRandom(adjacentOnly);
  assert.ok(rnd.total >= 50);
  assert.ok(rnd.matched < rnd.total, 'random tests expose it');
  assert.match(rnd.failure ?? '', /on input/);
  const ok = await oracle.evaluateRandom('def has_duplicate(numbers):\n    return len(set(numbers)) != len(numbers)');
  assert.equal(ok.matched, ok.total);
});

test('C++: an out-of-bounds read that happens to pass is caught by the runtime-checked build', { skip: !HAS_GXX && 'g++ not available', timeout: 600_000 }, async () => {
  const slow = 'bool has_dup(std::vector<int> v) {\n    for (size_t i = 0; i < v.size(); ++i)\n        for (size_t j = 0; j < v.size(); ++j)\n            if (i != j && v[i] == v[j]) return true;\n    return false;\n}';
  const oracle = await DifferentialTestOracle.build(fixedInputs([[[1, 2, 3]], [[3, 1, 3]], [[]], [[7, 7]]]), new CppAdapter(), slow);
  const oob = 'bool has_dup(std::vector<int> v) {\n    std::vector<int> s = v;\n    std::sort(s.begin(), s.end());\n    for (size_t i = 0; i <= s.size(); ++i) if (i + 1 <= s.size() && s[i] == s[i + 1]) return true;\n    return false;\n}';
  const flags = await new CppAdapter().sanitizerFlags();
  if (flags.length === 0) return; // toolchain without runtime checks — nothing to assert
  const rnd = await oracle.evaluateRandom(oob);
  assert.ok(rnd.matched < rnd.total, JSON.stringify(rnd));
});

test('numeric constants are taken from code, not from comments or strings', async () => {
  const { numericConstants } = await import('../src/core/fitness/testOracle/differential.js');
  const code = 'def clamp(x):  # 99 in a comment\n    s = "42"\n    if x < 10:\n        return x * 2.5\n    return 10';
  assert.deepEqual(numericConstants(code).sort((a, b) => a - b), [2.5, 10]);
});
