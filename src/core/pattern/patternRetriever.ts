import { loadPatternBase, type Pattern } from './patternBase.js';
import type { LanguageId } from '../lang/languageAdapter.js';

export interface RetrievedPatterns {
  similar: Pattern | null;
  different: Pattern | null;
}

// Unweighted Jaccard similarity treats every token equally, so without filtering, generic Python
// keywords (for/in/if/def/print) and complexity-notation fragments (the "n"/"o" in "O(n)") swamp
// the genuinely distinctive words — nearly every pattern's example contains "for"/"in"/"if", so
// they contribute intersection count without contributing any actual signal.
const STOPWORDS = new Set([
  'def', 'for', 'in', 'if', 'and', 'or', 'not', 'return', 'while', 'else', 'elif', 'import', 'from',
  'as', 'class', 'try', 'except', 'finally', 'with', 'lambda', 'pass', 'break', 'continue', 'is',
  'none', 'true', 'false', 'print', 'the', 'a', 'an', 'that', 'this', 'to', 'of', 'than', 'are',
  'be', 'it', 'its', 'when', 'only', 'due', 'by', 'up', 'each', 'other', 'same', 'one', 'into',
  // C++ keywords and ubiquitous std names — same reasoning as the Python entries above: they
  // appear in nearly every snippet, so they add intersection without adding signal.
  'int', 'long', 'short', 'char', 'bool', 'float', 'double', 'void', 'unsigned', 'signed',
  'const', 'static', 'auto', 'struct', 'std', 'size_t', 'nullptr', 'using', 'namespace',
  'include', 'template', 'typename', 'switch', 'case', 'new', 'delete', 'sizeof', 'begin', 'end',
]);

function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  return new Set(tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Plain Jaccard over "tags + description + slow" let a coincidental one-word overlap in a SHORT
// pattern outscore a genuinely relevant TAG match in a longer one, purely because the shorter
// pattern's smaller union size inflates its ratio. Tags are hand-curated specifically to be the
// searchable keywords for a pattern, so a query token matching a tag is real signal and should
// dominate; a match only in prose (description/slow) is much weaker, incidental signal.
function weightedScore(queryTokens: Set<string>, tagTokens: Set<string>, bodyTokens: Set<string>): number {
  let score = 0;
  for (const t of queryTokens) {
    if (tagTokens.has(t)) score += 3;
    else if (bodyTokens.has(t)) score += 1;
  }
  return score;
}

/**
 * Ports Algorithm 1's "Adaptive Optimization Pattern Retrieval" (paper §II-C): retrieves one
 * pattern semantically similar to the current attempts (to fix errors) and one different from
 * them (to surface an unexploited technique). The paper does this with BM25 over PIE-mined
 * ds/df diffs at corpus scale; against our ~12-entry curated base (ARCHITECTURE.md §4), plain
 * token-Jaccard similarity is equivalent in practice and far simpler — BM25 only starts to matter
 * once Phase 3 swaps in the PIE-scale corpus, at which point this class's *interface* stays the
 * same and only its internals need to change.
 */
export class PatternRetriever {
  private readonly patterns: Pattern[];

  constructor(lang: LanguageId) {
    this.patterns = loadPatternBase(lang);
  }

  retrieve(slowCode: string, representativeCode: string[]): RetrievedPatterns {
    if (this.patterns.length === 0) {
      return { similar: null, different: null };
    }

    // "Similar" is scored against the PROBLEM alone (slowCode) — mixing in representativeCode
    // here let a buggy attempt's incidental vocabulary (e.g. an attempt that used "set" wrong)
    // outrank a pattern that actually matches the problem's shape but not that vocabulary.
    const problemTokens = tokenize(slowCode);
    // "Different" should surface a technique NOT already reflected in what's been tried — scored
    // against how much each pattern's fix overlaps with the attempts' code, then inverted.
    const attemptTokens = tokenize(representativeCode.join(' '));

    const scored = this.patterns.map((pattern) => {
      const tagTokens = tokenize(pattern.tags.join(' '));
      const bodyTokens = tokenize(`${pattern.description} ${pattern.slow}`);
      // Normalized to 0..1 (max weight per token is 3) so it's comparable to alreadyTriedScore below.
      const inputScore =
        problemTokens.size > 0 ? weightedScore(problemTokens, tagTokens, bodyTokens) / (3 * problemTokens.size) : 0;
      const alreadyTriedScore = jaccard(attemptTokens, tokenize(pattern.fast));
      return { pattern, inputScore, alreadyTriedScore };
    });

    const bySimilar = [...scored].sort((a, b) => b.inputScore - a.inputScore);
    const similar = bySimilar[0]?.pattern ?? null;

    // Must still be plausibly relevant to the problem (inputScore) — otherwise "different" would
    // just surface a random unrelated pattern, which isn't useful mutation material either.
    const byDifferent = scored
      .filter((s) => s.pattern.id !== similar?.id)
      .sort((a, b) => b.inputScore - b.alreadyTriedScore - (a.inputScore - a.alreadyTriedScore));
    const different = byDifferent[0]?.pattern ?? null;

    return { similar, different };
  }
}
