/**
 * Okapi BM25, matching rank_bm25's BM25Okapi (what the reference implementation uses, with b=0.4):
 * idf = ln((N - n + 0.5) / (n + 0.5)), negative idfs floored at epsilon * mean idf, and every query
 * token counted as often as it occurs in the query.
 */
export class BM25 {
  private readonly docFreqs: Map<string, number>[] = [];
  private readonly docLens: number[] = [];
  private readonly idf = new Map<string, number>();
  private readonly avgdl: number;

  constructor(
    corpus: string[][],
    private readonly k1 = 1.5,
    private readonly b = 0.4,
    epsilon = 0.25,
  ) {
    const df = new Map<string, number>();
    let total = 0;
    for (const doc of corpus) {
      const freqs = new Map<string, number>();
      for (const t of doc) freqs.set(t, (freqs.get(t) ?? 0) + 1);
      this.docFreqs.push(freqs);
      this.docLens.push(doc.length);
      total += doc.length;
      for (const t of freqs.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = corpus.length;
    this.avgdl = n > 0 ? total / n : 0;

    let idfSum = 0;
    const negative: string[] = [];
    for (const [t, freq] of df) {
      const v = Math.log(n - freq + 0.5) - Math.log(freq + 0.5);
      this.idf.set(t, v);
      idfSum += v;
      if (v < 0) negative.push(t);
    }
    const floor = epsilon * (df.size > 0 ? idfSum / df.size : 0);
    for (const t of negative) this.idf.set(t, floor);
  }

  get size(): number {
    return this.docLens.length;
  }

  scores(query: string[]): number[] {
    const out = new Array<number>(this.docLens.length).fill(0);
    if (this.avgdl === 0) return out;
    for (const q of query) {
      const idf = this.idf.get(q);
      if (idf === undefined) continue;
      for (let i = 0; i < out.length; i++) {
        const f = this.docFreqs[i].get(q);
        if (!f) continue;
        out[i] += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * this.docLens[i]) / this.avgdl));
      }
    }
    return out;
  }
}

/** Tokens of (abstracted) code — identifiers/keywords, numbers, string placeholders, punctuation. */
export function codeTokens(text: string): string[] {
  return text.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|[^\s\w]/g) ?? [];
}

/** Min-max normalization to [0, 1]; all-equal input maps to all zeros (the reference divides by
 *  zero here and propagates NaN). */
export function minMax(xs: number[]): number[] {
  if (xs.length === 0) return xs;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return hi > lo ? xs.map((x) => (x - lo) / (hi - lo)) : xs.map(() => 0);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
