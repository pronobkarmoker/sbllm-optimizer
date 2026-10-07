import { codeTokens } from '../pattern/bm25.js';
import type { LanguageId } from '../lang/languageAdapter.js';

/** Removes comments so they don't count toward code similarity. */
export function stripComments(code: string, lang: LanguageId): string {
  if (lang === 'cpp') {
    return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  }
  // Python: drop `# ...` outside of string literals (good enough for similarity purposes).
  return code
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Length of the longest common subsequence of two token arrays (O(n·m) time, O(m) memory). */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}

/**
 * Sequence similarity of two token streams: 2·LCS / (|a| + |b|), in [0, 1] — the same ratio
 * difflib's SequenceMatcher reports. 1 means identical token sequences.
 */
export function tokenSequenceSimilarity(a: string[], b: string[], cap = 4000): number {
  const A = a.slice(0, cap);
  const B = b.slice(0, cap);
  if (A.length + B.length === 0) return 1;
  return (2 * lcsLength(A, B)) / (A.length + B.length);
}

export interface SideBySideRow {
  kind: 'same' | 'removed' | 'added' | 'changed';
  left?: { no: number; text: string };
  right?: { no: number; text: string };
}

/**
 * Aligns two texts line by line for a side-by-side view. Lines are matched on their trimmed text
 * (an indentation-only change counts as unchanged); a run of removed lines directly followed by a
 * run of added lines is paired up as "changed" rows, the way side-by-side diff viewers show edits.
 */
export function sideBySide(leftText: string, rightText: string): SideBySideRow[] {
  const L = leftText.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const R = rightText.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const n = L.length;
  const m = R.length;
  const key = (s: string) => s.trim();
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = key(L[i]) === key(R[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: SideBySideRow[] = [];
  let removed: { no: number; text: string }[] = [];
  let added: { no: number; text: string }[] = [];
  const flush = () => {
    const k = Math.max(removed.length, added.length);
    for (let x = 0; x < k; x++) {
      const left = removed[x];
      const right = added[x];
      rows.push({ kind: left && right ? 'changed' : left ? 'removed' : 'added', left, right });
    }
    removed = [];
    added = [];
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && key(L[i]) === key(R[j])) {
      flush();
      rows.push({ kind: 'same', left: { no: i + 1, text: L[i] }, right: { no: j + 1, text: R[j] } });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      removed.push({ no: i + 1, text: L[i] });
      i++;
    } else {
      added.push({ no: j + 1, text: R[j] });
      j++;
    }
  }
  flush();
  return rows;
}

export interface SyntacticSimilarity {
  /** Similarity of the raw token streams (comments removed). */
  tokenSimilarity: number;
  /** Similarity of the AST-abstracted token streams (identifiers → VAR, literals → NUM/STR): how
   *  similar the code's *structure* is, ignoring renames. null if either side doesn't parse. */
  structuralSimilarity: number | null;
  linesUnchanged: number;
  linesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export function syntacticSimilarity(
  original: string,
  candidate: string,
  lang: LanguageId,
  abstracted: { original: string | null; candidate: string | null },
): SyntacticSimilarity {
  const tokenSimilarity = tokenSequenceSimilarity(
    codeTokens(stripComments(original, lang)),
    codeTokens(stripComments(candidate, lang)),
  );
  const structuralSimilarity =
    abstracted.original !== null && abstracted.candidate !== null
      ? tokenSequenceSimilarity(codeTokens(abstracted.original), codeTokens(abstracted.candidate))
      : null;
  const rows = sideBySide(original, candidate);
  return {
    tokenSimilarity,
    structuralSimilarity,
    linesUnchanged: rows.filter((r) => r.kind === 'same').length,
    linesChanged: rows.filter((r) => r.kind === 'changed').length,
    linesAdded: rows.filter((r) => r.kind === 'added').length,
    linesRemoved: rows.filter((r) => r.kind === 'removed').length,
  };
}
