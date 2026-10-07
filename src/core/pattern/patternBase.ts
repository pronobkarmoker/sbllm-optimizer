import { readFileSync, statSync } from 'node:fs';
import { pythonPatterns } from './data/pythonPatterns.js';
import { cppPatterns } from './data/cppPatterns.js';
import type { LanguageId } from '../lang/languageAdapter.js';

export interface Pattern {
  id: string;
  /** Human-written explanation (curated patterns only). */
  description?: string;
  tags?: string[];
  /** The non-optimized code s of the optimization pair. */
  slow: string;
  /** The optimized version f. */
  fast: string;
  /** Precomputed abstractions s_a / f_a (mined pattern files); computed lazily when absent. */
  slowAbs?: string;
  fastAbs?: string;
  source: 'curated' | 'mined';
}

type RawPattern = Record<string, unknown>;

const SLOW_KEYS = ['slow', 'query', 'src_code', 'input', 'code_v0_no_empty_lines', 'code_v0'];
const FAST_KEYS = ['fast', 'reference', 'tgt_code', 'target', 'code_v1_no_empty_lines', 'code_v1'];

function pick(obj: RawPattern, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

const externalCache = new Map<string, { mtimeMs: number; patterns: Pattern[] }>();

/**
 * Reads an external pattern base: a JSON array, or JSON Lines, of optimization pairs. Accepts the
 * field names of this tool's own mined format (slow/fast, slowAbs/fastAbs), of the SBLLM
 * replication package (query/reference), and of the PIE dataset (src_code/tgt_code, input/target,
 * code_v0_no_empty_lines/code_v1_no_empty_lines), so a PIE training split can be pointed at directly.
 * Entries with a `lang`/`language` field for another language are skipped.
 */
export function loadExternalPatterns(filePath: string, lang: LanguageId): Pattern[] {
  const mtimeMs = statSync(filePath).mtimeMs;
  const key = `${lang}\0${filePath}`;
  const hit = externalCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.patterns;

  const text = readFileSync(filePath, 'utf8');
  let rows: RawPattern[];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    rows = JSON.parse(text);
  } else {
    rows = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  const patterns: Pattern[] = [];
  rows.forEach((row, i) => {
    const rowLang = String(row.lang ?? row.language ?? '').toLowerCase();
    if (rowLang && !(rowLang === lang || (lang === 'cpp' && (rowLang === 'c++' || rowLang === 'cc')))) return;
    const slow = pick(row, SLOW_KEYS);
    const fast = pick(row, FAST_KEYS);
    if (!slow || !fast || slow === fast) return;
    patterns.push({
      id: String(row.id ?? row.problem_id ?? `mined-${i}`),
      description: typeof row.description === 'string' ? row.description : undefined,
      slow,
      fast,
      slowAbs: typeof row.slowAbs === 'string' ? row.slowAbs : undefined,
      fastAbs: typeof row.fastAbs === 'string' ? row.fastAbs : undefined,
      source: 'mined',
    });
  });
  externalCache.set(key, { mtimeMs, patterns });
  return patterns;
}

/**
 * The pattern base T of Algorithm 1. The built-in, curated set of classic optimization idioms is
 * always included; an optional external file (e.g. mined from PIE's training split with
 * scripts/mine_patterns.py — the paper's actual source) is appended to it.
 */
export function loadPatternBase(lang: LanguageId, externalFile?: string): Pattern[] {
  const builtin = (lang === 'python' ? pythonPatterns : cppPatterns).map((p) => ({ ...p, source: 'curated' as const }));
  if (!externalFile) return builtin;
  return [...builtin, ...loadExternalPatterns(externalFile, lang)];
}
