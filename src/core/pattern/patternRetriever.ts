import { loadPatternBase, type Pattern } from './patternBase.js';
import { BM25, codeTokens, median, minMax } from './bm25.js';
import { diffLines } from './textDiff.js';
import type { LanguageAdapter } from '../lang/languageAdapter.js';

export interface RetrievedPattern {
  pattern: Pattern;
  /** The pattern's own slow→fast edit, difflib-style ("- " removed, "+ " added lines) — this is
   *  what the reference implementation shows the model. */
  diff: string;
  score: number;
}

export interface RetrievedPatterns {
  /** Similar to what the representative samples already do — helps rectify their errors. */
  similar: RetrievedPattern | null;
  /** Different from what they do — an unexploited optimization method (mutation material). */
  different: RetrievedPattern | null;
}

interface IndexedPattern {
  pattern: Pattern;
  diff: string;
}

/**
 * Ports Algorithm 1's "Adaptive Optimization Pattern Retrieval" (paper §II-C).
 *
 * Fine-grained pattern parsing: every optimization pair (s, f) in the pattern base is abstracted
 * (s_a, f_a) and diffed into its deleted statements d_s and added statements d_f. Three BM25
 * indices are built: over s_a, over d_s and over d_f.
 *
 * Representative-sample-based retrieval, with the scoring of the authors' released code (merge.py),
 * which refines the pseudocode's raw sums with normalization:
 *   input_score = minmax(BM25(Abstract(s_t), T.s_a))
 *   for each representative e: (ds, df) = GetDiff(Abstract(s_t), Abstract(e.code))
 *       edit = minmax(BM25(ds, T.d_s) + BM25(df, T.d_f))
 *       sim += (edit < median ? 0 : edit) / Ns              — patterns that edit like e does
 *       dif += (edit > median ? 0 : max(edit) - edit) / Ns  — patterns that edit unlike e
 *   similar   = argmax(input_score + sim)
 *   different = argmax(input_score + dif)
 * Both terms keep the input similarity, so the "different" pattern still fits the problem.
 */
export class PatternRetriever {
  private readonly patterns: Pattern[];
  private index: {
    items: IndexedPattern[];
    code: BM25;
    deleted: BM25;
    added: BM25;
  } | null = null;
  private building: Promise<void> | null = null;

  constructor(
    private readonly adapter: LanguageAdapter,
    opts: { patterns?: Pattern[]; externalFile?: string } = {},
  ) {
    this.patterns = opts.patterns ?? loadPatternBase(adapter.id, opts.externalFile);
  }

  get size(): number {
    return this.patterns.length;
  }

  private async ensureIndex(): Promise<void> {
    if (this.index) return;
    this.building ??= this.buildIndex();
    await this.building;
  }

  private async buildIndex(): Promise<void> {
    // Abstract whatever the pattern file didn't precompute, in one batched call.
    const need: string[] = [];
    for (const p of this.patterns) {
      if (p.slowAbs === undefined) need.push(p.slow);
      if (p.fastAbs === undefined) need.push(p.fast);
    }
    const abstracted = need.length > 0 ? await this.adapter.abstractMany(need).catch(() => need.map(() => null)) : [];
    const absOf = new Map<string, string | null>();
    need.forEach((c, i) => absOf.set(c, abstracted[i] ?? null));

    const items: IndexedPattern[] = [];
    const codeCorpus: string[][] = [];
    const delCorpus: string[][] = [];
    const addCorpus: string[][] = [];
    for (const p of this.patterns) {
      const sa = p.slowAbs ?? absOf.get(p.slow) ?? null;
      const fa = p.fastAbs ?? absOf.get(p.fast) ?? null;
      if (!sa || !fa) continue;
      const d = diffLines(sa.split('\n'), fa.split('\n'));
      if (d.deleted.length === 0 && d.added.length === 0) continue;
      const rawDiff = diffLines(p.slow.split('\n'), p.fast.split('\n'));
      items.push({ pattern: p, diff: rawDiff.ops.filter((l) => !l.startsWith('  ')).join('\n') });
      codeCorpus.push(codeTokens(sa));
      delCorpus.push(codeTokens(d.deleted.join('\n')));
      addCorpus.push(codeTokens(d.added.join('\n')));
    }
    this.index = {
      items,
      code: new BM25(codeCorpus),
      deleted: new BM25(delCorpus),
      added: new BM25(addCorpus),
    };
  }

  /**
   * @param slowCode the input slow code s_t
   * @param representativeCodes code of the selected representative samples RS (best first)
   */
  async retrieve(slowCode: string, representativeCodes: string[]): Promise<RetrievedPatterns> {
    await this.ensureIndex();
    const idx = this.index!;
    if (idx.items.length === 0) return { similar: null, different: null };

    const slowAbs = await this.adapter.abstract(slowCode).catch(() => null);
    const queryAbs = slowAbs ?? slowCode;
    const inputScore = minMax(idx.code.scores(codeTokens(queryAbs)));
    const sim = [...inputScore];
    const dif = [...inputScore];

    const ns = Math.max(1, representativeCodes.length);
    const repAbs = await this.adapter.abstractMany(representativeCodes).catch(() => representativeCodes.map(() => null));
    for (const candAbs of repAbs) {
      if (!candAbs) continue; // unparsable candidate — the reference skips these too
      const d = diffLines(queryAbs.split('\n'), candAbs.split('\n'));
      const del = idx.deleted.scores(codeTokens(d.deleted.join('\n')));
      const add = idx.added.scores(codeTokens(d.added.join('\n')));
      const raw = del.map((v, i) => v + add[i]);
      const hi = Math.max(...raw);
      const lo = Math.min(...raw);
      if (!(hi - lo > 0)) continue;
      const edit = minMax(raw);
      const med = median(edit);
      const top = Math.max(...edit);
      for (let i = 0; i < edit.length; i++) {
        sim[i] += (edit[i] < med ? 0 : edit[i]) / ns;
        dif[i] += (edit[i] > med ? 0 : top - edit[i]) / ns;
      }
    }

    const argmax = (xs: number[], exclude = -1) => {
      let best = -1;
      for (let i = 0; i < xs.length; i++) if (i !== exclude && (best === -1 || xs[i] > xs[best])) best = i;
      return best;
    };
    const s = argmax(sim);
    const d = argmax(dif, s);
    const wrap = (i: number, scores: number[]): RetrievedPattern | null =>
      i >= 0 ? { pattern: idx.items[i].pattern, diff: idx.items[i].diff, score: scores[i] } : null;
    return { similar: wrap(s, sim), different: wrap(d, dif) };
  }
}
