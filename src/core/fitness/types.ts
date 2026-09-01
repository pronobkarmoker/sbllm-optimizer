export interface Candidate {
  code: string;
  acc: number | null;
  speedup: number | null;
  avgTimeMs: number | null;
  error?: string;
  /** Human-readable GO-COT rationale (analysis + opportunities + explanation), for UI display. */
  explanation?: string;
}
