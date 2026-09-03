import { CppAdapter } from '../core/lang/cppAdapter.js';

const SLOW = `#include <vector>
using namespace std;

bool has_duplicate(vector<int> numbers) {
    for (size_t i = 0; i < numbers.size(); ++i) {
        for (size_t j = 0; j < numbers.size(); ++j) {
            if (i != j && numbers[i] == numbers[j]) return true;
        }
    }
    return false;
}`;

const FAST = `#include <vector>
#include <unordered_set>
using namespace std;

bool has_duplicate(vector<int> numbers) {
    unordered_set<int> seen;
    for (int v : numbers) {
        if (seen.count(v)) return true;
        seen.insert(v);
    }
    return false;
}`;

async function main() {
  const a = new CppAdapter();
  console.log('signature:', JSON.stringify(a.parseSignature(SLOW)));
  console.log('funcName :', a.extractFunctionName(SLOW), '| params:', a.extractParamNames(SLOW));

  const big: number[] = [];
  for (let i = 0; i < 4000; i++) big.push(i);
  const inputs: unknown[][] = [[[1, 2, 3]], [[1, 2, 2]], [[]], [big]];

  console.log('\n--- baseline alone ---');
  const b = await a.runBatch(SLOW, 'has_duplicate', inputs, 120_000);
  if (b.compileError) return console.log('COMPILE ERROR:', b.compileError);
  b.results!.forEach((r, i) => console.log(` [${i}] ok=${r.ok} out=${JSON.stringify(r.output)} t=${r.timeMs.toFixed(4)}ms`));

  console.log('\n--- candidate paired with baseline ---');
  const c = await a.runBatch(FAST, 'has_duplicate', inputs, 120_000, SLOW);
  if (c.compileError) return console.log('COMPILE ERROR:', c.compileError);
  c.results!.forEach((r, i) => {
    const sp = r.baselineTimeMs && r.timeMs ? (r.baselineTimeMs / r.timeMs).toFixed(1) : 'n/a';
    console.log(` [${i}] ok=${r.ok} out=${JSON.stringify(r.output)} t=${r.timeMs.toFixed(4)}ms base=${r.baselineTimeMs?.toFixed(4)}ms speedup=${sp}x`);
  });

  console.log('\n--- compile error surfaces cleanly? ---');
  const bad = await a.runBatch(FAST.replace('unordered_set<int> seen;', 'unordered_set<int> seen'), 'has_duplicate', inputs, 60_000);
  console.log(' ', bad.compileError?.slice(0, 120));
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
