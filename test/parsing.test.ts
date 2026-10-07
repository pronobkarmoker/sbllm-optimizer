import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePythonParams } from '../src/core/lang/pythonAdapter.js';
import { parseCppSignature, serializeArgs } from '../src/core/lang/cpp/harness.js';
import { findCppFunctions, stripMainFunction } from '../src/core/lang/cpp/cppSource.js';
import { findEnclosingFunctionRange, findEnclosingCppFunctionRange } from '../src/core/lang/functionRange.js';
import { CppAdapter, abstractCpp, unescapeLine } from '../src/core/lang/cppAdapter.js';
import { extractJson } from '../src/core/util/json.js';
import { parseGoCotResponse } from '../src/core/prompt/goCotPromptBuilder.js';
import { deepAlmostEqual } from '../src/core/util/deepAlmostEqual.js';

test('python params: looked up by name, generic type hints, defaults, markers', () => {
  const code = 'def _helper(a, b):\n    pass\n\ndef f(d: dict[str, int], xs: list[tuple[int, int]] = [], *, k=(1, 2)):\n    pass';
  assert.deepEqual(parsePythonParams(code, 'f'), ['d', 'xs', 'k']);
  assert.deepEqual(parsePythonParams(code), ['a', 'b']);
  assert.deepEqual(parsePythonParams('def g(*args, **kw):\n    pass', 'g'), ['*args', '**kw']);
  assert.deepEqual(parsePythonParams('def h(\n    a,\n    b,  # comment, with comma\n):\n    pass', 'h'), ['a', 'b']);
  assert.equal(parsePythonParams('def h(a): pass', 'missing'), null);
});

test('cpp signature: target found by name even after helpers', () => {
  const code = 'int sq(int x) { return x * x; }\nlong long target(const std::vector<int>& v, int k = 3) { return sq(k); }';
  const res = parseCppSignature(code, 'target');
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.sig.name, 'target');
    assert.deepEqual(res.sig.params.map((p) => p.name), ['v', 'k']);
    assert.equal(res.sig.params[0].mutable, false);
  }
});

test('cpp signature: nested vector return, mutable refs, unsupported types', () => {
  const r1 = parseCppSignature('std::vector<std::vector<int>> grid(int n) { return {}; }', 'grid');
  assert.ok(r1.ok);
  const r2 = parseCppSignature('void srt(std::vector<int>& v) { }', 'srt');
  assert.ok(r2.ok && r2.sig.params[0].mutable);
  const r3 = parseCppSignature('template <typename T> T id(T x) { return x; }', 'id');
  assert.ok(!r3.ok && /template/.test(r3.reason));
  const r4 = parseCppSignature('int f(int* p) { return *p; }', 'f');
  assert.ok(!r4.ok);
});

test('cpp scanner ignores braces in strings/comments and skips class methods', () => {
  const code = [
    '#include <string>',
    'struct S { int m() { return 1; } };',
    'namespace ns {',
    'static inline int a(int x) { const char* s = "}{"; /* } */ return x; }',
    '}',
    "int b(char c) { return c == '}'; }",
    'int main() { return 0; }',
  ].join('\n');
  const names = findCppFunctions(code).map((f) => f.name);
  assert.deepEqual(names, ['a', 'b', 'main']);
  assert.equal(findCppFunctions(code)[0].returnType, 'int');
  const stripped = stripMainFunction(code);
  assert.ok(stripped.removed && !/main/.test(stripped.code));
});

test('enclosing function ranges', () => {
  const py = ['import x', '', '@cache', 'async def f(a):', '    if a:', '        return 1', '    return 2', '', 'print(f(1))'];
  assert.deepEqual(findEnclosingFunctionRange(py, 5), { startLine: 2, endLine: 6 });
  assert.equal(findEnclosingFunctionRange(py, 8), null);
  const cpp = ['#include <vector>', 'int f(int a) {', '  if (a) {', '    return 1;', '  }', '  return 2;', '}', 'int g() { return 0; }'];
  assert.deepEqual(findEnclosingCppFunctionRange(cpp, 3), { startLine: 1, endLine: 6 });
  assert.deepEqual(findEnclosingCppFunctionRange(cpp, 7), { startLine: 7, endLine: 7 });
});

test('cpp serialization uses UTF-8 byte lengths and integer coercion', () => {
  const params = [
    { type: 'std::string', name: 's', mutable: false },
    { type: 'int', name: 'n', mutable: false },
  ];
  assert.equal(serializeArgs(params, ['héllo', 2.9]), '6\nhéllo\n2');
});

test('cpp abstraction keeps line structure and normalizes names/literals', () => {
  assert.equal(abstractCpp('int f(int a) {\n  return a + 42; // hi\n}'), 'int VAR(int VAR) {\nreturn VAR + NUM;\n}');
  assert.equal(unescapeLine('a\\\\nb\\nc'), 'a\\nb\nc');
});

test('cpp extractParamNames counts parameters of unsupported types too', () => {
  const a = new CppAdapter();
  assert.deepEqual(a.extractParamNames('int f(Foo* p, int q) { return q; }', 'f'), ['p', 'q']);
});

test('extractJson tolerates fences, comments, trailing commas and raw newlines', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1, // c\n "b": [1,2,],}\n```'), { a: 1, b: [1, 2] });
  assert.deepEqual(extractJson('{"code": "def f():\n    return 1"}'), { code: 'def f():\n    return 1' });
});

test('GO-COT parsing: JSON, inner fences, and last-code-block fallback', () => {
  const r1 = parseGoCotResponse(JSON.stringify({ analysis: 'a', opportunities: ['x', 'y'], explanation: 'e', code: '```python\ndef f(): pass\n```' }));
  assert.equal(r1.code, 'def f(): pass');
  assert.equal(r1.opportunities, '- x\n- y');
  const r2 = parseGoCotResponse('Original:\n```python\ndef slow(): pass\n```\nBetter:\n```python\ndef fast(): pass\n```');
  assert.equal(r2.code, 'def fast(): pass');
  assert.throws(() => parseGoCotResponse('no code here'));
});

test('deepAlmostEqual: float tolerance and structural equality', () => {
  assert.ok(deepAlmostEqual(0.1 + 0.2, 0.3));
  assert.ok(deepAlmostEqual({ __set__: [1, 2] }, { __set__: [1, 2] }));
  assert.ok(!deepAlmostEqual([1, 2], [2, 1]));
});
