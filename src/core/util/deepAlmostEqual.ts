/** Tolerant equality for comparing candidate output against ground truth — floats compare within a relative epsilon. */
export function deepAlmostEqual(a: unknown, b: unknown, eps = 1e-6): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepAlmostEqual(v, b[i], eps));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((k) => deepAlmostEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps));
  }
  return a === b;
}
