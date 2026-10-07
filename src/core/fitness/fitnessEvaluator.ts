import type { LanguageAdapter } from '../lang/languageAdapter.js';
import type { Candidate } from './types.js';

/**
 * Ports Algorithm 1's "Execution-based Representative Sample Selection" (paper §II-B, Alg. 1),
 * following the PAPER's pseudocode, which in one place disagrees with the authors' released code:
 *
 * - Candidates are sorted by speedup, descending.
 * - "Correct" means `acc === 1` EXACTLY. Algorithm 1 states this literally:
 *     `if e.acc == 1 and Abstract(e.code) not in correct_list`
 *   The released implementation instead buckets on `acc > 0` (merge.py), admitting partially
 *   passing candidates into the correct group. This code follows the paper.
 * - Correct candidates are deduped by AST abstraction, so three near-identical correct attempts
 *   don't crowd out three genuinely distinct optimization methods.
 * - If fewer than `n` survive, the pool is padded from the incorrect ones, sorted by ascending sum
 *   of abstracted edit distances — Algorithm 1: `incorrect_list = sort(incorrect_list, key=dis,
 *   order=ascend)`. Ascending sum-of-distances picks the most mutually SIMILAR candidates first
 *   (the released code names these `closest_segments`): the mistakes most representative of the
 *   pool. Code that does not parse contributes a large fixed distance, as in the released code.
 */
export class FitnessEvaluator {
  /** Abstraction is deterministic, and the same candidates are re-selected every iteration —
   *  caching avoids re-spawning the abstractor for the whole pool each time. */
  private readonly abstractionCache = new Map<string, string | null>();

  constructor(private readonly adapter: LanguageAdapter) {}

  async abstractAll(codes: string[]): Promise<(string | null)[]> {
    const missing = [...new Set(codes.filter((c) => !this.abstractionCache.has(c)))];
    if (missing.length > 0) {
      let abstracted: (string | null)[];
      try {
        abstracted = await this.adapter.abstractMany(missing);
      } catch {
        abstracted = missing.map(() => null);
      }
      missing.forEach((c, i) => this.abstractionCache.set(c, abstracted[i] ?? null));
    }
    return codes.map((c) => this.abstractionCache.get(c) ?? null);
  }

  async selectRepresentative<T extends Candidate>(candidates: T[], n: number): Promise<T[]> {
    const sorted = [...candidates].sort((a, b) => (b.speedup ?? 1) - (a.speedup ?? 1) || a.id - b.id);
    const correct = sorted.filter((c) => c.acc === 1);
    const incorrect = sorted.filter((c) => c.acc !== 1);

    const correctAbs = await this.abstractAll(correct.map((c) => c.code));
    const selected: T[] = [];
    const seen = new Set<string>();
    correct.forEach((c, i) => {
      const key = correctAbs[i] ?? c.code;
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(c);
      }
    });

    if (selected.length < n && incorrect.length > 0) {
      const abs = await this.abstractAll(incorrect.map((c) => c.code));
      const sums = new Array<number>(incorrect.length).fill(0);
      for (let i = 0; i < incorrect.length; i++) {
        for (let j = i + 1; j < incorrect.length; j++) {
          const ai = abs[i];
          const aj = abs[j];
          const d = ai === null || aj === null ? 9999 : editDistance(ai, aj);
          sums[i] += d;
          sums[j] += d;
        }
      }
      const order = incorrect.map((c, i) => ({ c, sum: sums[i] })).sort((a, b) => a.sum - b.sum || a.c.id - b.c.id);
      selected.push(...order.map((o) => o.c));
    }

    return selected.slice(0, n);
  }
}

/** Levenshtein distance in O(min(|a|,|b|)) memory. The previous full-matrix version allocated an
 *  |a|x|b| array per pair on the extension host's only thread. Inputs are capped: past a few
 *  thousand characters the ranking it feeds is already decided. */
export function editDistance(a: string, b: string, cap = 4000): number {
  if (a.length > cap) a = a.slice(0, cap);
  if (b.length > cap) b = b.slice(0, cap);
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
