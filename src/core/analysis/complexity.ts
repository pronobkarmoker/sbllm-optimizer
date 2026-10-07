import type { FunctionAnalysis } from './types.js';

/** Findings that put an O(n) operation inside a loop — each adds one factor of n. */
const LINEAR_IN_LOOP = new Set([
  'list-membership-in-loop',
  'list-search-in-loop',
  'loop-invariant-computation',
  'list-pop-front',
  'list-insert-front',
  'list-concat-in-loop',
  'string-concat-in-loop',
  'linear-search-in-loop',
  'vector-front-modification',
]);
const SORT_IN_LOOP = new Set(['sort-in-loop']);

function degree(c: string): number | null {
  if (c === 'O(1)') return 0;
  if (c === 'O(n)') return 1;
  const m = c.match(/^O\(n\^(\d+)\)$/);
  return m ? Number(m[1]) : null;
}

function fromDegree(d: number): string {
  return d === 0 ? 'O(1)' : d === 1 ? 'O(n)' : `O(n^${d})`;
}

/**
 * Refines the loop-nesting estimate with what the findings reveal: a linear operation hidden inside
 * a loop (`x in some_list`, `std::find`, `pop(0)`, ...) makes the function at least O(n^2) even
 * when loop nesting alone says O(n), and sorting makes it at least O(n log n).
 */
export function refineComplexity(fn: FunctionAnalysis): FunctionAnalysis {
  const base = degree(fn.complexity);
  if (base === null) return fn; // "exponential" etc.
  let d = base;
  // Lower bound only: the finding proves an O(n) step inside SOME loop, not inside the deepest one.
  if (fn.issues.some((i) => LINEAR_IN_LOOP.has(i.kind))) d = Math.max(d, 2);
  let complexity = fromDegree(d);
  if (fn.issues.some((i) => SORT_IN_LOOP.has(i.kind))) complexity = d >= 2 ? complexity : 'O(n^2 log n)';
  else if (d <= 1 && fn.issues.some((i) => i.kind === 'sort-for-min-max')) complexity = 'O(n log n)';
  return { ...fn, complexity };
}
