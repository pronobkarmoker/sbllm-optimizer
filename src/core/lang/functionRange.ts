import { findCppFunctions } from './cpp/cppSource.js';

export interface LineRange {
  startLine: number;
  endLine: number;
}

function indentOf(text: string): number {
  return text.match(/^(\s*)/)?.[1].length ?? 0;
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+\w+\s*\(/;

/**
 * Given a document's lines and an anchor line (cursor position or selection start), finds the
 * enclosing `def` block by scanning upward, tracking the shallowest indentation seen between the
 * anchor and each candidate `def` — a `def` only actually encloses the anchor if every non-blank
 * line between them stayed MORE indented than it; the moment a shallower line appears, any earlier
 * `def` above that point has already gone out of scope. Then scans downward from the matched `def`
 * until indentation returns to its own level (or EOF). Decorators directly above the `def` are
 * included, since they are part of the function (e.g. an existing @lru_cache).
 */
export function findEnclosingFunctionRange(lines: string[], anchorLine: number): LineRange | null {
  let defLine = -1;
  let defIndent = 0;
  let minIndent = Infinity;

  for (let line = anchorLine; line >= 0; line--) {
    const text = lines[line];
    if (text === undefined || text.trim() === '') continue;
    const match = text.match(PY_DEF);
    const indent = match ? match[1].length : indentOf(text);
    if (match && indent < minIndent) {
      defLine = line;
      defIndent = indent;
      break;
    }
    minIndent = Math.min(minIndent, indent);
  }

  if (defLine === -1) return null;

  let endLine = lines.length - 1;
  for (let line = defLine + 1; line < lines.length; line++) {
    const lineText = lines[line];
    if (lineText.trim() === '') continue;
    // A closing bracket of a multi-line signature sits at the def's own indentation.
    if (indentOf(lineText) <= defIndent && !/^\s*[)\]}]/.test(lineText)) {
      endLine = line - 1;
      break;
    }
  }
  while (endLine > defLine && lines[endLine].trim() === '') endLine--;

  let startLine = defLine;
  while (startLine > 0 && /^\s*@/.test(lines[startLine - 1]) && indentOf(lines[startLine - 1]) === defIndent) startLine--;

  return { startLine, endLine };
}

/**
 * C++ equivalent, built on the shared source scanner (which ignores braces inside strings,
 * character literals, comments and preprocessor lines). Returns the innermost namespace-scope
 * function whose definition spans the anchor line.
 */
export function findEnclosingCppFunctionRange(lines: string[], anchorLine: number): LineRange | null {
  const fns = findCppFunctions(lines.join('\n'));
  const hit = fns.find((f) => f.startLine <= anchorLine && anchorLine <= f.endLine);
  return hit ? { startLine: hit.startLine, endLine: hit.endLine } : null;
}
