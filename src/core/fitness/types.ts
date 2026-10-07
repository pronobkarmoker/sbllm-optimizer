/** Execution-based fitness of one piece of code against a set of test cases. */
export interface Fitness {
  /** Fraction of test cases whose observable behaviour matched the original (1 = correct). */
  acc: number;
  /** Original time / candidate time, measured in the same process (paired baseline). Only
   *  meaningful when acc === 1; 1 otherwise, as in the paper's SP metric. May be < 1 for a correct
   *  but slower candidate — that is kept as measured, not clamped, so ranking stays informative. */
  speedup: number;
  /** Mean candidate time per call over the matched test cases. */
  avgTimeMs: number | null;
  /** Mean time per call of the ORIGINAL over the same test cases, from the paired measurement. */
  baselineTimeMs: number | null;
  error?: string;
}

export interface Candidate extends Fitness {
  /** Stable index into the session history (shown as #id in the UI). */
  id: number;
  code: string;
  /** 0 for the initial population, 1..n for evolutionary iterations. */
  iteration: number;
  /** Human-readable GO-COT rationale (analysis + opportunities + explanation), for UI display. */
  explanation?: string;
}

/** A finalist re-measured on the held-out private test cases. */
export interface VerifiedCandidate extends Candidate {
  publicAcc: number;
  publicSpeedup: number;
}
