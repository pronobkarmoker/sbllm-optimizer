import type { PythonAdapter } from '../lang/pythonAdapter.js';
import type { Candidate } from './types.js';

/**
 * Ports Algorithm 1's "Execution-based Representative Sample Selection" (paper §II-B / Alg. 1
 * lines 2-19), matching the reference implementation's `selection()` in merge.py
 * (sbllm/sbllm/merge.py:325-369) bucket-for-bucket:
 *
 * - "Correct" is `acc > 0`, NOT `acc === 1` — a candidate that passes most but not all test cases
 *   is still real signal (merge.py: `if obj['acc'] is not None and obj['acc']>0`). An earlier
 *   version of this code required `acc === 1` to enter this bucket at all, which meant a
 *   nearly-correct, genuinely fast candidate got dumped in with total failures and only ever
 *   surfaced via distance-based padding — discarding exactly the "almost there" signal GO-COT's
 *   crossover step is designed to build on. The *label* shown to the model in the prompt (correct
 *   vs incorrect attempt, in goCotPromptBuilder.ts) still keys strictly off `acc === 1`, matching
 *   evol_query.py's `prompt_construction()` (sbllm/sbllm/evol_query.py:112-117) — these are two
 *   separate concerns in the paper's own code and must not be collapsed into one.
 * - Within that bucket, candidates are ranked by the paper's own combined speed+accuracy score,
 *   `(time/input_time) / (0.01 + acc)` ascending (smaller = faster AND more correct = better) —
 *   not a simple speedup sort — then deduped by AST abstraction so three near-identical correct
 *   attempts don't crowd out three genuinely distinct optimization methods (the exact mechanism
 *   the reference-repo bug we fixed earlier broke for Python).
 * - If fewer than `n` candidates survive that, the pool is padded from the remaining acc===0
 *   candidates, ordered by ascending total abstracted edit-distance to the rest of that pool —
 *   i.e. the candidates most representative of the pool's common mistakes come first. This is NOT
 *   a distinctness ranking despite how it reads; it mirrors merge.py's `closest_segments` naming
 *   literally — an ascending sort by sum-of-distances-to-others picks the most mutually-similar
 *   candidates first, not the most distinct ones.
 */
export class FitnessEvaluator {
  constructor(private readonly adapter: PythonAdapter) {}

  async selectRepresentative(candidates: Candidate[], n: number): Promise<Candidate[]> {
    const correctPool = candidates.filter((c) => (c.acc ?? 0) > 0);
    const wrongPool = candidates.filter((c) => (c.acc ?? 0) <= 0);

    const ranked = correctPool
      .map((c) => {
        const speedup = c.speedup ?? 1;
        const timeRatio = speedup > 0 ? 1 / speedup : 1;
        return { c, key: timeRatio / (0.01 + (c.acc ?? 0)) };
      })
      .sort((a, b) => a.key - b.key)
      .map((x) => x.c);

    const selected: Candidate[] = [];
    const seenAbstractions: string[] = [];
    for (const c of ranked) {
      const abs = await this.adapter.abstract(c.code).catch(() => null);
      const key = abs ?? c.code;
      if (!seenAbstractions.includes(key)) {
        seenAbstractions.push(key);
        selected.push(c);
      }
    }

    if (selected.length < n && wrongPool.length > 0) {
      const abstractions = await Promise.all(wrongPool.map((c) => this.adapter.abstract(c.code).catch(() => c.code)));
      const distances = wrongPool.map((c, i) => {
        let sum = 0;
        for (let j = 0; j < wrongPool.length; j++) {
          if (i === j) continue;
          sum += editDistance(abstractions[i] ?? '', abstractions[j] ?? '');
        }
        return { c, sum };
      });
      distances.sort((a, b) => a.sum - b.sum);
      selected.push(...distances.map((d) => d.c));
    }

    return selected.slice(0, n);
  }
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
