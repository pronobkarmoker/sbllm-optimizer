export interface LineDiff {
  /** Lines present only in the first text — the paper's "abstracted deleted statements" ds. */
  deleted: string[];
  /** Lines present only in the second text — the paper's "abstracted added statements" df. */
  added: string[];
  /** Unified listing in difflib.Differ style ("  ", "- ", "+ " prefixes), in order. */
  ops: string[];
}

/**
 * Line-level LCS diff, the equivalent of the reference implementation's `difflib.Differ().compare`
 * used to isolate ds/df from an optimization pair (paper §II-C, "Fine-grained Pattern Parsing").
 * Lines are compared after trimming, so indentation changes alone don't count as edits.
 */
export function diffLines(a: string[], b: string[]): LineDiff {
  const A = a.map((l) => l.trim()).filter((l) => l !== '');
  const B = b.map((l) => l.trim()).filter((l) => l !== '');
  const n = A.length;
  const m = B.length;
  // Guard against pathological sizes: mined corpora can contain whole programs.
  if (n * m > 4_000_000) {
    const setB = new Set(B);
    const setA = new Set(A);
    const deleted = A.filter((l) => !setB.has(l));
    const added = B.filter((l) => !setA.has(l));
    return { deleted, added, ops: [...deleted.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)] };
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const deleted: string[] = [];
  const added: string[] = [];
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push(`  ${A[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deleted.push(A[i]);
      ops.push(`- ${A[i++]}`);
    } else {
      added.push(B[j]);
      ops.push(`+ ${B[j++]}`);
    }
  }
  while (i < n) {
    deleted.push(A[i]);
    ops.push(`- ${A[i++]}`);
  }
  while (j < m) {
    added.push(B[j]);
    ops.push(`+ ${B[j++]}`);
  }
  return { deleted, added, ops };
}
