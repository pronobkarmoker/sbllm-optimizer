import { findCppFunctions, maskCpp, type CppFunctionInfo } from '../lang/cpp/cppSource.js';
import type { AnalysisIssue, FileAnalysis, FunctionAnalysis, IssueSeverity } from './types.js';

interface LoopRecord {
  start: number;
  headerEnd: number;
  parent: number;
  trivial: boolean;
}

interface StatementRecord {
  start: number;
  end: number;
  /** Index into loops of the innermost enclosing loop, or -1. */
  loop: number;
}

/** A loop over a small constant range (`for (int d = 0; d < 4; ++d)`) or a braced literal list
 *  doesn't change the asymptotic cost. */
function isTrivialHeader(header: string): boolean {
  const bound = header.match(/<=?\s*(\d+)\s*;/);
  if (bound && Number(bound[1]) <= 16 && !/\.size\(\)|\bn\b/.test(header)) return true;
  if (/:\s*\{[^}]*\}\s*$/.test(header)) return true;
  return false;
}

/**
 * Statement-level walk of a C++ function body (on masked source, so strings/comments can't
 * confuse it), recording every loop with its parent loop and every simple statement with its
 * innermost enclosing loop. Single-statement loop bodies (`for (...) for (...) x++;`) nest
 * correctly, which a brace-only scan gets wrong.
 */
class BodyWalker {
  readonly loops: LoopRecord[] = [];
  readonly statements: StatementRecord[] = [];

  constructor(private readonly m: string) {}

  private skipWs(i: number): number {
    while (i < this.m.length && /\s/.test(this.m[i])) i++;
    return i;
  }

  private matchParen(i: number): number {
    let depth = 0;
    for (; i < this.m.length; i++) {
      if (this.m[i] === '(') depth++;
      else if (this.m[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return this.m.length - 1;
  }

  private wordAt(i: number): string {
    const w = this.m.slice(i).match(/^[A-Za-z_]\w*/);
    return w ? w[0] : '';
  }

  /** Parses a `{ ... }` block starting at `i`; returns the index after the closing brace. */
  block(i: number, loop: number, end: number): number {
    i++; // past '{'
    for (;;) {
      i = this.skipWs(i);
      if (i >= end || i >= this.m.length) return i;
      if (this.m[i] === '}') return i + 1;
      const next = this.statement(i, loop, end);
      i = next > i ? next : i + 1;
    }
  }

  statement(i: number, loop: number, end: number): number {
    i = this.skipWs(i);
    if (i >= end) return i;
    const c = this.m[i];
    if (c === '{') return this.block(i, loop, end);
    if (c === ';') return i + 1;
    const w = this.wordAt(i);

    if (w === 'for' || w === 'while') {
      const open = this.skipWs(i + w.length);
      if (this.m[open] !== '(') return this.simple(i, loop, end);
      const close = this.matchParen(open);
      const header = this.m.slice(open + 1, close);
      const after = this.skipWs(close + 1);
      if (this.m[after] === ';') return after + 1; // `while (x);` — tail of a do-while, or an empty loop
      const idx = this.loops.push({ start: i, headerEnd: close, parent: loop, trivial: isTrivialHeader(header) }) - 1;
      // The loop header itself runs every iteration (e.g. `while (find(...))`).
      this.statements.push({ start: open, end: close, loop: idx });
      return this.statement(after, idx, end);
    }
    if (w === 'do') {
      const idx = this.loops.push({ start: i, headerEnd: i + 2, parent: loop, trivial: false }) - 1;
      let j = this.statement(i + 2, idx, end);
      j = this.skipWs(j);
      if (this.wordAt(j) === 'while') {
        const open = this.skipWs(j + 5);
        const close = this.matchParen(open);
        this.statements.push({ start: open, end: close, loop: idx });
        j = this.skipWs(close + 1);
        if (this.m[j] === ';') j++;
      }
      return j;
    }
    if (w === 'if' || w === 'switch') {
      let open = this.skipWs(i + w.length);
      if (this.wordAt(open) === 'constexpr') open = this.skipWs(open + 9);
      if (this.m[open] !== '(') return this.simple(i, loop, end);
      const close = this.matchParen(open);
      this.statements.push({ start: open, end: close, loop });
      let j = this.statement(close + 1, loop, end);
      const k = this.skipWs(j);
      if (w === 'if' && this.wordAt(k) === 'else') j = this.statement(k + 4, loop, end);
      return j;
    }
    if (w === 'else') return this.statement(i + 4, loop, end);
    if (w === 'try') {
      let j = this.statement(i + 3, loop, end);
      for (;;) {
        const k = this.skipWs(j);
        if (this.wordAt(k) !== 'catch') return j;
        const open = this.skipWs(k + 5);
        const close = this.matchParen(open);
        j = this.statement(close + 1, loop, end);
      }
    }
    return this.simple(i, loop, end);
  }

  /** An expression/declaration statement: up to the `;` at nesting depth 0 (lambdas included). */
  private simple(i: number, loop: number, end: number): number {
    let depth = 0;
    let j = i;
    for (; j < end; j++) {
      const ch = this.m[j];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break; // closing brace of the enclosing block
        depth--;
      } else if (ch === ';' && depth === 0) {
        j++;
        break;
      }
    }
    this.statements.push({ start: i, end: j, loop });
    return j;
  }
}

function lineCol(code: string, offset: number): { line: number; col: number } {
  let line = 0;
  let last = -1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last - 1 };
}

const LINEAR_ALGOS = /\b(?:std::)?(find|find_if|count|count_if|accumulate|max_element|min_element|search|remove|reverse|all_of|any_of|none_of)\s*\(/g;

function analyzeFunction(code: string, masked: string, fn: CppFunctionInfo): FunctionAnalysis {
  const issues: AnalysisIssue[] = [];
  const seen = new Set<string>();
  const add = (kind: string, severity: IssueSeverity, start: number, end: number, message: string, suggestion: string) => {
    const s = lineCol(code, start);
    const e = lineCol(code, Math.max(start + 1, end));
    const key = `${kind}:${s.line}:${s.col}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, severity, line: s.line, col: s.col, endLine: e.line, endCol: e.col, message, suggestion });
  };

  const walker = new BodyWalker(masked);
  walker.block(fn.bodyOpen, -1, fn.bodyClose + 1);
  const { loops, statements } = walker;

  const nonTrivialDepth = (idx: number): number => {
    let d = 0;
    for (let i = idx; i !== -1; i = loops[i].parent) if (!loops[i].trivial) d++;
    return d;
  };

  // Nested loops: report once per outermost non-trivial loop, with the deepest nesting under it.
  let maxDepth = 0;
  const deepestUnder = new Map<number, number>();
  loops.forEach((l, i) => {
    const d = nonTrivialDepth(i);
    maxDepth = Math.max(maxDepth, d);
    let root = i;
    while (loops[root].parent !== -1) root = loops[root].parent;
    deepestUnder.set(root, Math.max(deepestUnder.get(root) ?? 0, d));
  });
  for (const [root, depth] of deepestUnder) {
    if (depth >= 2) {
      add(
        'nested-loops',
        'warning',
        loops[root].start,
        loops[root].headerEnd + 1,
        `Loops nested ${depth} deep — this is likely O(n^${depth}) in the input size.`,
        'Look for a hash set/map lookup, sorting + two pointers, or prefix sums that remove an inner loop.',
      );
    }
  }

  const stringVars = new Set<string>();
  for (const m of masked.slice(fn.bodyOpen, fn.bodyClose).matchAll(/\b(?:std::)?string\s+([A-Za-z_]\w*)/g)) stringVars.add(m[1]);

  for (const st of statements) {
    if (st.loop === -1 || nonTrivialDepth(st.loop) === 0) continue;
    const text = masked.slice(st.start, st.end);
    const raw = code.slice(st.start, st.end);

    for (const m of text.matchAll(LINEAR_ALGOS)) {
      if (!/\.begin\(\)|\bbegin\(/.test(text)) continue;
      const at = st.start + (m.index ?? 0);
      add(
        'linear-search-in-loop',
        'warning',
        at,
        at + m[0].length,
        `\`${m[1]}\` scans a whole range on every loop iteration (O(n) each time).`,
        m[1].startsWith('find') || m[1].startsWith('count')
          ? 'Build an unordered_set/unordered_map once before the loop for O(1) lookups.'
          : 'Compute the result once before the loop, or maintain it incrementally.',
      );
    }
    const front = text.match(/\.\s*(erase|insert)\s*\(\s*([A-Za-z_]\w*)\s*\.\s*begin\s*\(\s*\)/);
    if (front) {
      add(
        'vector-front-modification',
        'warning',
        st.start,
        st.end,
        `\`${front[1]}\` at the front of \`${front[2]}\` shifts every element — O(n) per call inside a loop.`,
        'Use std::deque (push_front/pop_front), or process from the back / reverse once at the end.',
      );
    }
    if (/\bsort\s*\(/.test(text)) {
      add('sort-in-loop', 'warning', st.start, st.end, 'Sorting inside a loop repeats an O(n log n) step every iteration.', 'Sort once before the loop, or keep the data in a std::set / priority_queue.');
    }
    if (/\bendl\b/.test(text)) {
      add('endl-in-loop', 'info', st.start, st.end, '`std::endl` flushes the stream on every iteration.', "Write '\\n' instead and let the stream flush once.");
    }
    const concat = raw.match(/\b([A-Za-z_]\w*)\s*=\s*\1\s*\+/);
    if (concat && stringVars.has(concat[1])) {
      add(
        'string-concat-in-loop',
        'warning',
        st.start,
        st.end,
        `\`${concat[1]} = ${concat[1]} + ...\` builds a new string every iteration — O(n^2) overall.`,
        `Append in place with \`${concat[1]} += ...\` (and reserve() if the final size is known).`,
      );
    }
  }

  // Containers passed by value are copied on every call.
  let offset = 0;
  for (const piece of fn.paramsText.split(/,(?![^<]*>)/)) {
    const p = piece.trim();
    const at = fn.paramsStart + offset + (piece.length - piece.trimStart().length);
    offset += piece.length + 1;
    if (/\b(vector|string|map|set|unordered_map|unordered_set|deque)\b/.test(p) && !/&/.test(p)) {
      add(
        'pass-by-value',
        'info',
        at,
        at + p.length,
        `\`${p}\` is copied on every call.`,
        'Take it by const reference (const T&) if the function does not need its own copy.',
      );
    }
  }

  // Exponential recursion: two or more self-calls and no memo table.
  const body = masked.slice(fn.bodyOpen, fn.bodyClose);
  // Only calls that shrink a parameter (f(n - 1), f(n / 2)) count: recursing on a child node or a
  // loop variable is a tree walk, not overlapping subproblems.
  const params = fn.paramsText
    .split(',')
    .map((p) => p.trim().match(/([A-Za-z_]\w*)\s*(?:=.*)?$/)?.[1])
    .filter((p): p is string => !!p);
  const shrinks = new RegExp(`\\b(${params.join('|') || '(?!)'})\\s*[-+/>]|[-+]\\s*\\b(${params.join('|') || '(?!)'})\\b`);
  const argsAt = (start: number): string => {
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) return body.slice(start + 1, i);
    }
    return '';
  };
  const selfCalls = [...body.matchAll(new RegExp(`\\b${fn.name}\\s*\\(`, 'g'))].filter((m) =>
    shrinks.test(argsAt((m.index ?? 0) + m[0].length - 1)),
  );
  if (selfCalls.length >= 2 && !/\b\w*(memo|cache|dp)\w*\b/i.test(body)) {
    const at = fn.bodyOpen + (selfCalls[0].index ?? 0);
    add(
      'exponential-recursion',
      'warning',
      at,
      at + fn.name.length,
      `\`${fn.name}\` calls itself ${selfCalls.length} times per invocation without memoization — overlapping subproblems make this exponential.`,
      'Memoize results in a table, or rewrite bottom-up (dynamic programming).',
    );
  }

  // No loops, but a whole-range operation (sort, a container built from a range, an STL algorithm
  // over .begin()/.end()) is still O(n) or O(n log n).
  const loopless = /\bsort\s*\(/.test(body)
    ? 'O(n log n)'
    : /\.begin\s*\(\s*\)|\baccumulate\s*\(|\b(count|find|max_element|min_element)\s*\(/.test(body)
      ? 'O(n)'
      : 'O(1)';
  const complexity = issues.some((i) => i.kind === 'exponential-recursion')
    ? 'exponential'
    : maxDepth === 0
      ? loopless
      : maxDepth === 1
        ? 'O(n)'
        : `O(n^${maxDepth})`;

  return {
    name: fn.name,
    startLine: fn.startLine,
    endLine: fn.endLine,
    // main() is driver code with no inputs to vary — analyzed, but not offered for optimization.
    topLevel: fn.name !== 'main',
    complexity,
    issues: issues.sort((a, b) => a.line - b.line || a.col - b.col),
  };
}

export function analyzeCpp(code: string): FileAnalysis {
  const masked = maskCpp(code);
  const functions = findCppFunctions(code).map((fn) => analyzeFunction(code, masked, fn));
  return { language: 'cpp', functions };
}
