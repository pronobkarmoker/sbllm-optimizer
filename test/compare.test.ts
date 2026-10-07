import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideBySide, syntacticSimilarity, tokenSequenceSimilarity, stripComments } from '../src/core/compare/similarity.js';
import { previewValue } from '../src/core/fitness/testOracle/differential.js';
import { EvolutionaryOptimizer } from '../src/core/optimizer/evolutionaryOptimizer.js';
import { HAS_PYTHON, SCRIPTS_DIR, ScriptedLLM, goCot } from './helpers.js';

test('token sequence similarity', () => {
  assert.equal(tokenSequenceSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(tokenSequenceSimilarity(['a', 'b'], ['c', 'd']), 0);
  assert.equal(tokenSequenceSimilarity(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), 0.75);
});

test('side-by-side alignment pairs removed/added runs as changed lines', () => {
  const rows = sideBySide('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(rows.map((r) => r.kind), ['same', 'changed', 'same', 'same', 'added']);
  assert.equal(rows[1].left?.text, 'b');
  assert.equal(rows[1].right?.text, 'B');
  assert.equal(rows[4].left, undefined);
  // Indentation-only changes count as unchanged.
  assert.equal(sideBySide('  x = 1', 'x = 1')[0].kind, 'same');
});

test('comments are ignored for similarity; renames do not lower structural similarity', () => {
  assert.equal(stripComments('x = 1  # note\ny = "#not a comment"', 'python'), 'x = 1  \ny = "#not a comment"');
  const a = 'def f(xs):\n    return len(xs)';
  const b = 'def f(items):  # renamed\n    return len(items)';
  const s = syntacticSimilarity(a, b, 'python', { original: 'def f(VAR):\n    return len(VAR)', candidate: 'def f(VAR):\n    return len(VAR)' });
  assert.equal(s.structuralSimilarity, 1);
  assert.ok(s.tokenSimilarity < 1);
});

test('value previews elide long lists and show sets naturally', () => {
  assert.equal(previewValue([1, 2, 3, 4, 5, 6, 7, 8]), '[1, 2, 3, 4, 5, 6, … (8 items)]');
  assert.equal(previewValue({ __set__: ['a', 'b'] }), 'set{"a", "b"}');
  assert.equal(previewValue(null), 'None');
});

const SLOW = `def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False`;
const FAST = `def has_duplicate(numbers):
    return len(set(numbers)) != len(numbers)`;
const INPUTS = JSON.stringify({ inputs: [[[1, 2, 3]], [[1, 2, 1]], [[]], [[5]], [[7, 7]], [[3, 1, 4, 1, 5]]] });

test('compare(): syntactic + semantic similarity and per-input behaviour for a real candidate', { skip: !HAS_PYTHON && 'python not available', timeout: 180_000 }, async () => {
  const opt = new EvolutionaryOptimizer(new ScriptedLLM(INPUTS, [goCot(FAST)]), { scriptsDir: SCRIPTS_DIR, language: 'python' });
  const result = await opt.optimize(SLOW, { maxIterations: 1, generationNumber: 1 });
  assert.ok(result.best);
  const report = await opt.compare(result.best!);
  assert.equal(report.functionName, 'has_duplicate');
  assert.equal(report.semantic.matched, report.semantic.total, 'identical behaviour on every input');
  assert.equal(report.semantic.equivalence, 1);
  assert.ok(report.semantic.cases.some((c) => c.stress), 'stress inputs are included');
  assert.ok(report.semantic.cases.some((c) => c.split === 'private'), 'held-out inputs are included');
  assert.ok(report.speedup! > 10, `speedup ${report.speedup}`);
  assert.ok(report.syntactic.tokenSimilarity > 0 && report.syntactic.tokenSimilarity < 1);
  assert.ok(report.syntactic.structuralSimilarity !== null);
  assert.equal(report.complexity.original, 'O(n^2)');
  assert.equal(report.complexity.candidate, 'O(1)');
  assert.equal(report.rows[0].kind, 'same', 'the def line is unchanged');

  // A wrong candidate: semantic similarity < 100% and the failing inputs are explained.
  const wrong = { ...result.best!, id: 99, code: 'def has_duplicate(numbers):\n    return False' };
  const bad = await opt.compare(wrong);
  assert.ok(bad.semantic.matched < bad.semantic.total);
  assert.ok(bad.semantic.cases.some((c) => !c.match && /return value/.test(c.reason ?? '')));
  assert.equal(bad.speedup, null);
});
