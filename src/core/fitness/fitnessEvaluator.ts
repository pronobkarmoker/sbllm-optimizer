import type { PythonAdapter } from '../lang/pythonAdapter.js';
import type { Candidate } from './types.js';

/**
 * Ports Algorithm 1's "Execution-based Representative Sample Selection" (paper §III, Alg. 1),
 * following the PAPER's pseudocode, which in one place disagrees with the authors' released code:
 *
 * - Candidates are sorted by speedup, descending ("sort the code snippets by speedup rate").
 * - "Correct" means `acc === 1` EXACTLY. Algorithm 1 states this literally:
 *     `if e.acc == 1 and Abstract(e.code) not in correct_list`
 *   The released implementation instead buckets on `acc > 0` (merge.py:329), admitting partially
 *   passing candidates into the correct group. That is a real divergence between the paper and its
 *   own artifact, and this code follows the paper. Note the two rules coincide whenever the correct
 *   group is all-`acc==1` anyway: merge.py's ranking key `(time/input_time)/(0.01+acc)` reduces to
 *   `(time/input_time)/1.01` there, whose ascending order is exactly speedup-descending.
 * - Correct candidates are deduped by AST abstraction, so three near-identical correct attempts
 *   don't crowd out three genuinely distinct optimization methods (the exact mechanism the
 *   reference-repo bug fixed earlier broke for Python).
 * - If fewer than `n` survive, the pool is padded from the incorrect ones, sorted by ascending sum
 *   of abstracted edit distances — Algorithm 1: `incorrect_list = sort(incorrect_list, key=dis,
 *   order=ascend)`. Despite reading like a distinctness ranking, ascending sum-of-distances picks
 *   the most mutually SIMILAR candidates first (the released code names these `closest_segments`),
 *   i.e. the mistakes most representative of the pool. Paper and released code agree here.
 */
export class FitnessEvaluator {
  constructor(private readonly adapter: PythonAdapter) {}

  async selectRepresentative(candidates: Candidate[], n: number): Promise<Candidate[]> {
    const sorted = [...candidates].sort((a, b) => (b.speedup ?? 1) - (a.speedup ?? 1));
    const ranked = sorted.filter((c) => c.acc === 1);
    const wrongPool = sorted.filter((c) => c.acc !== 1);

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
