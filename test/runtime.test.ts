import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PythonAdapter } from '../src/core/lang/pythonAdapter.js';
import { CppAdapter } from '../src/core/lang/cppAdapter.js';
import { HAS_GXX, HAS_PYTHON, SCRIPTS_DIR } from './helpers.js';

const noPy = !HAS_PYTHON && 'python not available';
const noCxx = !HAS_GXX && 'g++ not available';

test('python: a candidate calling sys.exit() is a failed call, not a crashed batch', { skip: noPy }, async () => {
  const r = await new PythonAdapter(SCRIPTS_DIR).runBatch('import sys\ndef f(x):\n    sys.exit(0)', 'f', [[1]]);
  assert.equal(r.results?.[0].ok, false);
  assert.match(r.results![0].error!, /SystemExit/);
});

test('python: a non-terminating candidate times out cleanly', { skip: noPy }, async () => {
  const r = await new PythonAdapter(SCRIPTS_DIR).runBatch('def f(x):\n    while True: pass', 'f', [[1]], 2000);
  assert.match(r.compileError ?? '', /timed out/);
});

test('python: sets are canonical across processes; mutation is observable', { skip: noPy }, async () => {
  const a = new PythonAdapter(SCRIPTS_DIR);
  const r1 = await a.runBatch('def f(xs):\n    return set(xs)', 'f', [[['pear', 'apple', 'fig']]]);
  assert.deepEqual(r1.results?.[0].output, { __set__: ['apple', 'fig', 'pear'] });
  const r2 = await a.runBatch('def f(xs):\n    xs.sort()', 'f', [[[3, 1, 2]]]);
  assert.deepEqual(r2.results?.[0].argsAfter, [[1, 2, 3]]);
});

test('python: module-level prints in the context do not corrupt the protocol', { skip: noPy }, async () => {
  const r = await new PythonAdapter(SCRIPTS_DIR).runBatch('print("x", end="")\ndef f(a):\n    return a + 1', 'f', [[1]]);
  assert.equal(r.results?.[0].output, 2);
});

test('python: context preparation drops side effects but keeps definitions', { skip: noPy }, async () => {
  const ctx = await new PythonAdapter(SCRIPTS_DIR).prepareContext(
    'import math\nLIMIT = 10\nn = int(input())\nprint(n)\ndef helper(x):\n    return x\nif __name__ == "__main__":\n    main()\n',
  );
  assert.match(ctx.code, /import math/);
  assert.match(ctx.code, /LIMIT = 10/);
  assert.match(ctx.code, /def helper/);
  assert.doesNotMatch(ctx.code, /input\(|print\(|__main__/);
  assert.equal(ctx.skipped.length, 3);
});

test('c++: char params, per-input exceptions, helpers before the target', { skip: noCxx }, async () => {
  const a = new CppAdapter();
  const c = await a.runBatch('int code(char c) { return (int)c; }', 'code', [['a']]);
  assert.equal(c.results?.[0].output, 97);

  const e = await a.runBatch('#include <vector>\nint at3(std::vector<int> v) { return v.at(3); }', 'at3', [[[1]], [[1, 2, 3, 4]]]);
  assert.equal(e.results?.[0].ok, false);
  assert.equal(e.results?.[1].output, 4);

  const h = await a.runBatch(
    'int sq(int x) { return x * x; }\nint target(int n) { return sq(n) + 1; }',
    'target',
    [[3]],
    60_000,
    'int target(int n) { return n * n + 1; }',
  );
  assert.equal(h.results?.[0].output, 10);
  assert.ok((h.results?.[0].baselineTimeMs ?? -1) >= 0);
});

test('c++: in-place mutation is observable and strings round-trip as JSON', { skip: noCxx }, async () => {
  const a = new CppAdapter();
  const m = await a.runBatch('#include <algorithm>\nvoid srt(std::vector<int>& v) { std::sort(v.begin(), v.end()); }', 'srt', [[[3, 1, 2]]]);
  assert.deepEqual(m.results?.[0].argsAfter, [[1, 2, 3]]);
  const s = await a.runBatch('std::string q(std::string s) { return "\\"" + s + "\\\\"; }', 'q', [['é\n']]);
  assert.equal(s.results?.[0].output, '"é\n\\');
});
