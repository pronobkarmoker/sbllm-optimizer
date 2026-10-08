import { findCppFunctions, maskCpp } from '../../lang/cpp/cppSource.js';

export interface Mutant {
  description: string;
  code: string;
}

const CPP_MUTATIONS: { re: RegExp; to: string; label: string }[] = [
  { re: /\s==\s/g, to: ' != ', label: '== -> !=' },
  { re: /\s!=\s/g, to: ' == ', label: '!= -> ==' },
  { re: /\s<=\s/g, to: ' < ', label: '<= -> <' },
  { re: /\s>=\s/g, to: ' > ', label: '>= -> >' },
  { re: /\s<\s/g, to: ' <= ', label: '< -> <=' },
  { re: /\s>\s/g, to: ' >= ', label: '> -> >=' },
  { re: /&&/g, to: '||', label: '&& -> ||' },
  { re: /\|\|/g, to: '&&', label: '|| -> &&' },
  { re: /\+\s*1\b/g, to: '- 1', label: '+ 1 -> - 1' },
  { re: /(?<![\w)\]])-\s*1\b|\s-\s*1\b/g, to: ' + 1', label: '- 1 -> + 1' },
  { re: /\btrue\b/g, to: 'false', label: 'true -> false' },
  { re: /\bfalse\b/g, to: 'true', label: 'false -> true' },
];

/**
 * Single-mutation variants of a C++ function: operator and constant swaps inside its body (never
 * inside comments or string literals — matching is done on the masked source, whose offsets equal
 * the original's). Spread evenly over the available mutation points.
 */
export function cppMutants(code: string, funcName: string, limit: number): Mutant[] {
  const fn = findCppFunctions(code).find((f) => f.name === funcName);
  if (!fn) return [];
  const masked = maskCpp(code);
  const body = masked.slice(fn.bodyOpen, fn.bodyClose);
  const points: { at: number; len: number; to: string; label: string }[] = [];
  for (const m of CPP_MUTATIONS) {
    for (const hit of body.matchAll(m.re)) {
      points.push({ at: fn.bodyOpen + (hit.index ?? 0), len: hit[0].length, to: m.to, label: m.label });
    }
  }
  points.sort((a, b) => a.at - b.at);
  if (points.length === 0) return [];
  const step = Math.max(1, points.length / limit);
  const chosen = [...new Set(Array.from({ length: Math.min(limit, points.length) }, (_, i) => Math.floor(i * step)))];
  return chosen.map((i) => {
    const p = points[i];
    const line = code.slice(0, p.at).split('\n').length;
    return { description: `${p.label} (line ${line})`, code: code.slice(0, p.at) + p.to + code.slice(p.at + p.len) };
  });
}

/** Small deterministic PRNG (mulberry32) so random tests are reproducible run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random inputs shaped like the function's real inputs (the generated inputs that survived the
 * contract filters): same argument kinds, element types and value ranges, but random lengths and
 * contents, deliberately biased toward the cases that break "clever" rewrites — duplicates (values
 * drawn from a small pool), already-sorted and reverse-sorted lists, empty and single-element lists.
 * Arguments of a shape it doesn't understand (nested lists, dicts) reuse observed values.
 *
 * `constants` are numeric literals from the function's own source: boundaries like `x < 10` are
 * where bugs hide, so numbers are also drawn at each constant and one either side of it.
 */
export function buildRandomInputs(examples: unknown[][], count: number, seed = 20251009, constants: number[] = []): unknown[][] {
  if (examples.length === 0) return [];
  const rand = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const arity = Math.max(...examples.map((e) => e.length));
  const boundary = [...new Set(constants.filter((c) => Number.isFinite(c) && Math.abs(c) < 1e6).flatMap((c) => [c - 1, c, c + 1]))];

  const generators = Array.from({ length: arity }, (_, i) => {
    const values = examples.map((e) => e[i]).filter((v) => v !== undefined);
    const lists = values.filter(Array.isArray) as unknown[][];
    const elems = lists.flat();
    const nums = [...values, ...elems].filter((v): v is number => typeof v === 'number');
    const strs = [...values, ...elems].filter((v): v is string => typeof v === 'string');
    const isFloat = nums.some((n) => !Number.isInteger(n));
    const lo = nums.length ? Math.min(...nums) : 0;
    const hi = nums.length ? Math.max(...nums) : 9;
    const span = Math.max(hi - lo, 9);
    const num = (pool: boolean) => {
      if (boundary.length && rand() < 0.3) return pick(boundary);
      const v = pool ? lo + Math.floor(rand() * Math.min(span + 1, 6)) : lo - span + rand() * (3 * span);
      return isFloat ? Math.round(v * 2) / 2 : Math.round(v);
    };
    const str = (pool: boolean) => {
      if (strs.length && rand() < 0.5) return pick(strs);
      const alphabet = pool ? 'ab' : 'abcxyz';
      const n = Math.floor(rand() * (pool ? 3 : 7));
      return Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
    };
    const maxLen = Math.min(40, Math.max(12, ...lists.map((l) => l.length)));
    const flatKind = elems.length && elems.every((v) => typeof v === 'number')
      ? 'num'
      : elems.length && elems.every((v) => typeof v === 'string')
        ? 'str'
        : elems.length && elems.every((v) => typeof v === 'boolean')
          ? 'bool'
          : null;

    return (): unknown => {
      const template = pick(values);
      if (Array.isArray(template) && (flatKind || template.length === 0)) {
        if (!flatKind) return [];
        const r = rand();
        const len = r < 0.1 ? 0 : r < 0.2 ? 1 : 2 + Math.floor(rand() * (maxLen - 1));
        const pool = rand() < 0.6; // small value pool → duplicates are likely
        let list: unknown[] = Array.from({ length: len }, () =>
          flatKind === 'num' ? num(pool) : flatKind === 'str' ? str(pool) : rand() < 0.5,
        );
        const order = rand();
        if (flatKind !== 'bool' && order < 0.2) list = [...list].sort((a, b) => (a as number | string) < (b as number | string) ? -1 : 1);
        else if (flatKind !== 'bool' && order < 0.35) list = [...list].sort((a, b) => (a as number | string) < (b as number | string) ? 1 : -1);
        return list;
      }
      if (typeof template === 'number') return num(rand() < 0.3);
      if (typeof template === 'string') return str(rand() < 0.3);
      if (typeof template === 'boolean') return rand() < 0.5;
      return template; // null, nested lists, dicts: reuse an observed value
    };
  });

  const out: unknown[][] = [];
  const seen = new Set<string>();
  for (let tries = 0; out.length < count && tries < count * 5; tries++) {
    const entry = generators.map((g) => g());
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
