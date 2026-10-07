/**
 * Lightweight C++ source scanning shared by signature parsing, context preparation, enclosing-
 * function detection and static analysis. Not a C++ parser — just enough structure (comments,
 * literals, preprocessor lines, brace nesting) to find function definitions reliably.
 */

export interface CppFunctionInfo {
  name: string;
  /** Return type text as written, with storage specifiers (static/inline/...) removed. */
  returnType: string;
  /** Raw text between the parameter list's parentheses, and its offset in the source. */
  paramsText: string;
  paramsStart: number;
  isTemplate: boolean;
  /** Offset of the first character of the declaration (after any template<...> prefix). */
  start: number;
  /** Offsets of the body's opening and closing brace. */
  bodyOpen: number;
  bodyClose: number;
  startLine: number;
  endLine: number;
}

const NOT_FUNCTIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'decltype', 'alignof', 'alignas',
  'static_assert', 'noexcept', 'operator', 'new', 'delete', 'throw', 'case', 'do', 'else',
]);
const STORAGE = /\b(static|inline|constexpr|consteval|extern|virtual|friend|explicit)\b|\[\[[^\]]*\]\]/g;

/**
 * Returns `code` with the same length and line structure, but with comments and preprocessor lines
 * blanked and the contents of string/char literals replaced by spaces (quotes kept). Offsets into the
 * masked text are offsets into the original.
 */
export function maskCpp(code: string): string {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  let lineStart = true;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (lineStart && /\s/.test(c) && c !== '\n') {
      i++;
      continue;
    }
    if (lineStart && c === '#') {
      // Preprocessor directive, including backslash-continued lines.
      while (i < n && code[i] !== '\n') {
        if (code[i] === '\\' && code[i + 1] === '\n') {
          out[i] = ' ';
          i += 2;
          continue;
        }
        out[i] = ' ';
        i++;
      }
      continue;
    }
    lineStart = c === '\n';
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    if (c === 'R' && next === '"') {
      // Raw string literal R"delim( ... )delim"
      const open = code.indexOf('(', i + 2);
      if (open !== -1) {
        const delim = code.slice(i + 2, open);
        const close = code.indexOf(`)${delim}"`, open);
        if (close !== -1) {
          for (let k = i + 2; k < close + delim.length + 1; k++) if (code[k] !== '\n') out[k] = ' ';
          i = close + delim.length + 2;
          continue;
        }
      }
    }
    if (c === '"' || c === "'") {
      // Skip digit separators like 1'000'000.
      if (c === "'" && i > 0 && /[0-9A-Fa-f]/.test(code[i - 1]) && /[0-9A-Fa-f]/.test(next ?? '')) {
        i++;
        continue;
      }
      const quote = c;
      i++;
      while (i < n && code[i] !== quote && code[i] !== '\n') {
        if (code[i] === '\\') {
          out[i] = ' ';
          i++;
        }
        if (i < n && code[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

function lineOf(code: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

function matchForward(masked: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Finds function definitions at namespace scope (global or inside `namespace X { ... }` /
 * `extern "C" { ... }`). Class member functions are not returned.
 */
export function findCppFunctions(code: string): CppFunctionInfo[] {
  const masked = maskCpp(code);
  const out: CppFunctionInfo[] = [];
  // Brace stack: true for transparent (namespace-like) blocks.
  const stack: boolean[] = [];
  let stmtStart = 0;

  const atNamespaceScope = () => stack.every(Boolean);

  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === ';') {
      stmtStart = i + 1;
      continue;
    }
    if (c === '}') {
      stack.pop();
      stmtStart = i + 1;
      continue;
    }
    if (c === '{') {
      const before = masked.slice(stmtStart, i);
      stack.push(/\bnamespace\b/.test(before) || /\bextern\s*"\s*"/.test(before));
      stmtStart = i + 1;
      continue;
    }
    if (c !== '(' || !atNamespaceScope()) continue;

    // Identifier immediately before '('.
    let j = i - 1;
    while (j >= 0 && /\s/.test(masked[j])) j--;
    const idEnd = j + 1;
    while (j >= 0 && /[\w]/.test(masked[j])) j--;
    const name = masked.slice(j + 1, idEnd);
    if (!/^[A-Za-z_]\w*$/.test(name) || NOT_FUNCTIONS.has(name)) continue;
    // Qualified names (Foo::bar) are out-of-class member definitions — not free functions.
    if (masked.slice(Math.max(0, j - 1), j + 1) === '::') continue;

    const closeParen = matchForward(masked, i, '(', ')');
    if (closeParen === -1) continue;
    let k = closeParen + 1;
    // Trailing qualifiers before the body.
    for (;;) {
      while (k < masked.length && /\s/.test(masked[k])) k++;
      const rest = masked.slice(k, k + 12);
      const q = rest.match(/^(const|noexcept|override|final)\b/);
      if (q) {
        k += q[0].length;
        continue;
      }
      break;
    }
    if (masked[k] !== '{') {
      // A declaration or a call; either way not a definition. Jump past the parens.
      i = closeParen;
      continue;
    }

    let declText = masked.slice(stmtStart, j + 1);
    let declStart = stmtStart;
    const isTemplate = /\btemplate\s*</.test(declText);
    if (isTemplate) {
      const tEnd = matchForward(declText, declText.indexOf('<', declText.search(/\btemplate\b/)), '<', '>');
      if (tEnd !== -1) {
        declStart = stmtStart + tEnd + 1;
        declText = declText.slice(tEnd + 1);
      }
    }
    const lead = declText.length - declText.trimStart().length;
    declStart += lead;
    const returnType = code
      .slice(declStart, j + 1)
      .replace(STORAGE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Something like `x = foo(...) {` is not a definition; a return type must be present.
    if (!returnType || /[=;,()]/.test(returnType)) {
      i = closeParen;
      continue;
    }

    const bodyClose = matchForward(masked, k, '{', '}');
    if (bodyClose === -1) break;
    out.push({
      name,
      returnType,
      paramsText: code.slice(i + 1, closeParen),
      paramsStart: i + 1,
      isTemplate,
      start: declStart,
      bodyOpen: k,
      bodyClose,
      startLine: lineOf(code, declStart),
      endLine: lineOf(code, bodyClose),
    });
    i = bodyClose;
    stmtStart = bodyClose + 1;
  }
  return out;
}

/** Removes `main()` (and nothing else) — the file context must be compilable into a harness that has
 *  its own main, and a user's main is driver code the target function cannot depend on. */
export function stripMainFunction(code: string): { code: string; removed: boolean } {
  const main = findCppFunctions(code).find((f) => f.name === 'main');
  if (!main) return { code, removed: false };
  return { code: code.slice(0, main.start) + code.slice(main.bodyClose + 1), removed: true };
}
