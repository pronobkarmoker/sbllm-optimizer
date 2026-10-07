import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCpp } from '../src/core/analysis/cppAnalyzer.js';
import { CodeAnalyzer } from '../src/core/analysis/analyzer.js';
import { refineComplexity } from '../src/core/analysis/complexity.js';
import { HAS_PYTHON, SCRIPTS_DIR } from './helpers.js';

const kinds = (fns: { issues: { kind: string }[] }[]) => fns.flatMap((f) => f.issues.map((i) => i.kind)).sort();

test('C++ analyzer flags nested loops, linear search in loop, endl, by-value containers, recursion', () => {
  const code = `#include <vector>
#include <algorithm>
#include <iostream>
bool has_dup(std::vector<int> v) {
  for (size_t i = 0; i < v.size(); ++i)
    for (size_t j = 0; j < v.size(); ++j)
      if (i != j && v[i] == v[j]) return true;
  return false;
}
int count_in(const std::vector<int>& a, const std::vector<int>& b) {
  int n = 0;
  for (int x : a) {
    if (std::find(b.begin(), b.end(), x) != b.end()) n++;
    std::cout << x << std::endl;
  }
  for (int d = 0; d < 4; ++d) { for (int x : a) n += x; }
  return n;
}
long long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`;
  const res = analyzeCpp(code);
  const byName = Object.fromEntries(res.functions.map((f) => [f.name, f]));
  assert.deepEqual(kinds([byName.has_dup]), ['nested-loops', 'pass-by-value']);
  assert.equal(byName.has_dup.complexity, 'O(n^2)');
  // The 4-iteration outer loop is trivial, so `count_in` is O(n), not O(n^2).
  assert.deepEqual(kinds([byName.count_in]), ['endl-in-loop', 'linear-search-in-loop']);
  assert.equal(byName.count_in.complexity, 'O(n)');
  // ...but the find() inside the loop is another factor of n.
  assert.equal(refineComplexity(byName.count_in).complexity, 'O(n^2)');
  assert.deepEqual(kinds([byName.fib]), ['exponential-recursion']);
  assert.equal(byName.fib.complexity, 'exponential');
  const nested = byName.has_dup.issues.find((i) => i.kind === 'nested-loops')!;
  assert.equal(nested.line, 4);
});

test('Python analyzer flags common inefficiencies', { skip: !HAS_PYTHON && 'python not available' }, async () => {
  const code = `def has_duplicate(numbers):
    seen = []
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    for x in numbers:
        if x in seen:
            return True
        seen.append(x)
        total = sum(numbers)
    return False

def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)

def build(words):
    out = ""
    for w in words:
        out += w
    return sorted(words)[0], out

def clean(xs):
    return [x * 2 for x in xs]
`;
  const res = await new CodeAnalyzer({ scriptsDir: SCRIPTS_DIR }).analyze(code, 'python');
  assert.equal(res.error, undefined);
  const byName = Object.fromEntries(res.functions.map((f) => [f.name, f]));
  assert.deepEqual(kinds([byName.has_duplicate]), ['list-membership-in-loop', 'loop-invariant-computation', 'nested-loops']);
  assert.equal(byName.has_duplicate.complexity, 'O(n^2)');
  assert.equal(byName.has_duplicate.issues[0].line, 2); // 0-based
  assert.deepEqual(kinds([byName.fib]), ['exponential-recursion']);
  assert.deepEqual(kinds([byName.build]), ['sort-for-min-max', 'string-concat-in-loop']);
  assert.deepEqual(byName.clean.issues, []);
});

test('Python analyzer reports syntax errors instead of throwing', { skip: !HAS_PYTHON && 'python not available' }, async () => {
  const res = await new CodeAnalyzer({ scriptsDir: SCRIPTS_DIR }).analyze('def f(:\n  pass', 'python');
  assert.match(res.error ?? '', /SyntaxError/);
});

test('recursion over child nodes is not flagged as exponential; f(n-1) + f(n-2) is', { skip: !HAS_PYTHON && 'python not available' }, async () => {
  const code = `def walk(node):
    total = 0
    for child in node.children:
        total += walk(child)
    return total + walk_extra(node)

def keep(node):
    return all(keep(s) for s in node.body) and all(keep(h) for h in node.handlers)

def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
`;
  const res = await new CodeAnalyzer({ scriptsDir: SCRIPTS_DIR }).analyze(code, 'python');
  const byName = Object.fromEntries(res.functions.map((f) => [f.name, f]));
  assert.deepEqual(kinds([byName.keep]), []);
  assert.deepEqual(kinds([byName.fib]), ['exponential-recursion']);
  const cpp = analyzeCpp('int depth(std::vector<int> kids, int i) { return depth(kids, kids[i]) + depth(kids, kids[i + 1]); }\nint fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }');
  const c = Object.fromEntries(cpp.functions.map((f) => [f.name, f]));
  assert.deepEqual(kinds([c.fib]), ['exponential-recursion']);
});
