import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25, codeTokens, minMax } from '../src/core/pattern/bm25.js';
import { diffLines } from '../src/core/pattern/textDiff.js';
import { PatternRetriever } from '../src/core/pattern/patternRetriever.js';
import { FitnessEvaluator, editDistance } from '../src/core/fitness/fitnessEvaluator.js';
import { CppAdapter } from '../src/core/lang/cppAdapter.js';
import type { Candidate } from '../src/core/fitness/types.js';
import { buildIterationPrompt } from '../src/core/prompt/goCotPromptBuilder.js';

test('BM25 ranks the document sharing rare terms highest', () => {
  const bm = new BM25([codeTokens('a b c'), codeTokens('x y unordered_set'), codeTokens('a a b')]);
  const s = bm.scores(codeTokens('unordered_set x'));
  assert.equal(s.indexOf(Math.max(...s)), 1);
  assert.deepEqual(minMax([2, 2]), [0, 0]);
});

test('line diff extracts deleted (ds) and added (df) statements', () => {
  const d = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'y']);
  assert.deepEqual(d.deleted, ['b']);
  assert.deepEqual(d.added, ['x', 'y']);
});

test('edit distance', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('same', 'same'), 0);
});

const SLOW_DUP = `bool has_dup(std::vector<int> v) {
    for (size_t i = 0; i < v.size(); ++i) {
        for (size_t j = 0; j < v.size(); ++j) {
            if (i != j && v[i] == v[j]) return true;
        }
    }
    return false;
}`;

test('pattern retrieval (Algorithm 1): similar matches the problem, different is another pattern', async () => {
  const retriever = new PatternRetriever(new CppAdapter());
  const attempt = SLOW_DUP.replace('std::vector<int> v', 'const std::vector<int>& v');
  const r = await retriever.retrieve(SLOW_DUP, [attempt]);
  assert.ok(r.similar && r.different);
  assert.notEqual(r.similar!.pattern.id, r.different!.pattern.id);
  assert.match(r.similar!.diff, /^[-+] /m);
});

function cand(id: number, code: string, acc: number, speedup: number): Candidate {
  return { id, code, acc, speedup, avgTimeMs: acc === 1 ? 1 : null, baselineTimeMs: acc === 1 ? speedup : null, iteration: 0 };
}

test('representative selection (Algorithm 1): correct first by speedup, deduped by abstraction, then incorrect', async () => {
  const fe = new FitnessEvaluator(new CppAdapter());
  const pool = [
    cand(0, 'int f(int a) { return a + 1; }', 1, 1.5),
    cand(1, 'int f(int b) { return b + 2; }', 1, 2.0), // same abstraction as #0 — a duplicate method
    cand(2, 'int f(int a) { return a * 3; }', 1, 1.2),
    cand(3, 'int f(int a) { return a - 1 }', 0, 1),
    cand(4, 'int f(int a) { return a - 2 }', 0, 1),
  ];
  const rs = await fe.selectRepresentative(pool, 3);
  assert.deepEqual(rs.map((c) => c.id), [1, 2, 3]);
});

test('GO-COT prompt has the crossover / mutation / generation structure and the patterns', async () => {
  const retriever = new PatternRetriever(new CppAdapter());
  const patterns = await retriever.retrieve(SLOW_DUP, []);
  const p = buildIterationPrompt('cpp', SLOW_DUP, [cand(0, SLOW_DUP, 1, 1.0), cand(1, 'bad', 0, 1)], patterns);
  assert.match(p.system!, /\[Crossover\]/);
  assert.match(p.system!, /\[Mutation\]/);
  assert.match(p.system!, /\[Generation\]/);
  assert.match(p.user, /Pattern 1 — similar/);
  assert.match(p.user, /\[Version 2\] Incorrect version/);
});

test('generated inputs that break the inferred contract are dropped', async () => {
  const { filterToContract, shapeOf } = await import('../src/core/fitness/testOracle/differential.js');
  assert.equal(shapeOf([1, 2.5]), 'list<num>');
  assert.equal(shapeOf([[1], [2]]), 'list<list<num>>');
  assert.equal(shapeOf([1, 'a']), 'list<num|str>');
  const inputs = [[[1, 2, 3]], [[]], [[5, 5]], [[[1, 2], [1, 2]]], [[1, 'a', null]], [[-1, -2]]];
  const { kept, dropped } = filterToContract(inputs);
  assert.deepEqual(kept, [[[1, 2, 3]], [[]], [[5, 5]], [[-1, -2]]]);
  assert.equal(dropped.length, 2);
  // No clear majority -> nothing is dropped.
  assert.equal(filterToContract([[1], ['a'], [[1]]]).dropped.length, 0);
});

test('a test-input reply truncated by the token cap keeps its complete entries', async () => {
  const { salvageInputEntries } = await import('../src/core/fitness/testOracle/differential.js');
  // The exact shape of a real qwen2.5-coder:1.5b reply that ran into the cap.
  const truncated = '```json\n{\n  "inputs": [\n    [[1, 2, 3]],\n    [[-1, -2, -3]],\n    [[1, 1, 1]],\n    [["a]", "b"]],\n    [[1, 2, 3, 4, 5, 6';
  assert.deepEqual(salvageInputEntries(truncated), [[[1, 2, 3]], [[-1, -2, -3]], [[1, 1, 1]], [['a]', 'b']]]);
  assert.deepEqual(salvageInputEntries('no json here'), []);
});

test('flat-list contract: real model inputs with dicts / nested / None lists are dropped even without a majority', async () => {
  const { filterToContract } = await import('../src/core/fitness/testOracle/differential.js');
  // Captured from qwen2.5-coder:1.5b for has_duplicate(numbers) — no single majority shape.
  const run0 = [[5], [-100], [7777777777], [9.8], ['string'], [null], [true], [[[1, 2], 3, 4]], [[0, 1, 2]], [[9, 8, 7]], [[100, 200]]];
  const r0 = filterToContract(run0);
  assert.ok(!r0.kept.some((e) => JSON.stringify(e) === '[[[1,2],3,4]]'), 'mixed nested list must be dropped');
  assert.ok(r0.kept.some((e) => JSON.stringify(e) === '[[0,1,2]]'));

  const run1 = [[[]], [[-10, 5]], [['hi', 'there']], [[1, 2, 2]], [[{}, {}]], [[null, null]]];
  const r1 = filterToContract(run1);
  assert.ok(!r1.kept.some((e) => JSON.stringify(e) === '[[{},{}]]'), 'list of dicts must be dropped');
  assert.ok(!r1.kept.some((e) => JSON.stringify(e) === '[[null,null]]'), 'list of None must be dropped');
  assert.ok(r1.kept.some((e) => JSON.stringify(e) === '[["hi","there"]]'), 'a flat list of strings is a valid input');

  // A function that really takes a matrix: nested lists are the contract and are kept.
  const matrix = [[[[1, 2], [3, 4]]], [[[5]]], [[[1, 1], [2, 2], [3, 3]]], [[1, 2]]];
  const rm = filterToContract(matrix);
  assert.equal(rm.kept.filter((e) => Array.isArray((e[0] as unknown[])[0])).length, 3);
});

test('execution-based contract: flat lists that work on the original rule out nested/dict inputs', async () => {
  const { preferFlatLists } = await import('../src/core/fitness/testOracle/differential.js');
  // has_duplicate accepted all of these; the flat ones prove flat lists are its contract.
  const ran = [[[1, 2, 3]], [[[1, 2], [1, 2]]], [[[1, 2], [3, 4], [1, 2]]], [['a', 'b']], [[{}, {}]], [[]]];
  assert.deepEqual([...preferFlatLists(ran)].sort(), [1, 2, 4]);
  // A matrix function: flat lists would have raised on the original, so only nested ones ran.
  const matrix = [[[[1, 2], [3, 4]]], [[[5]]], [[]]];
  assert.equal(preferFlatLists(matrix).size, 0);
});

test('patterns are shown as complete example functions, labelled "different function, technique only"', async () => {
  const pat = (slow: string, fast: string) => ({
    pattern: { id: 'p', description: 'Use a set.', slow, fast, source: 'curated' as const },
    diff: '- old\n+ new',
    score: 1,
  });
  const small = pat('def count_allowed(values, allowed):\n    return sum(v in allowed for v in values)', 'def count_allowed(values, allowed):\n    s = set(allowed)\n    return sum(v in s for v in values)');
  const p = buildIterationPrompt('python', 'def f(xs):\n    return xs', [cand(0, 'def f(xs):\n    return xs', 1, 1)], { similar: small, different: null });
  assert.match(p.user, /Example — a DIFFERENT, self-contained function/);
  assert.match(p.user, /Before:\n```python\ndef count_allowed\(values, allowed\):/);
  assert.match(p.user, /After:\n```python\ndef count_allowed/);
  assert.match(p.user, /Technique: Use a set\./);
  // A long mined pattern (a whole program) falls back to the compact diff.
  const long = pat(Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join('\n'), 'x = 1');
  const q = buildIterationPrompt('python', 'def f(xs):\n    return xs', [], { similar: long, different: null });
  assert.match(q.user, /```diff\n- old\n\+ new/);
});
