export interface LineRange {
  startLine: number;
  endLine: number;
}

function indentOf(text: string): number {
  return text.match(/^(\s*)/)?.[1].length ?? 0;
}

/**
 * Given a document's lines and an anchor line (cursor position or selection start), finds the
 * enclosing `def` block by scanning upward, tracking the shallowest indentation seen between the
 * anchor and each candidate `def` — a `def` only actually encloses the anchor if every non-blank
 * line between them stayed MORE indented than it; the moment a shallower line appears, any earlier
 * `def` above that point has already gone out of scope. Without this tracking, the naive "nearest
 * `def` line found scanning upward" can silently mis-scope: a cursor placed on top-level code that
 * merely follows a function (not inside it) would wrongly bind to that preceding function, and a
 * cursor inside an outer function whose body contains a nested `def` would wrongly bind to the
 * inner one instead of the true enclosing outer one. Then scans downward from the matched `def`
 * until indentation returns to its own level (or EOF). Pure text logic, no VS Code dependency —
 * the extension layer (extension.ts) is a thin wrapper around this that converts to/from
 * vscode.Range.
 */
export function findEnclosingFunctionRange(lines: string[], anchorLine: number): LineRange | null {
  let defLine = -1;
  let defIndent = 0;
  let minIndent = Infinity;

  for (let line = anchorLine; line >= 0; line--) {
    const text = lines[line];
    if (text === undefined || text.trim() === '') continue;
    const match = text.match(/^(\s*)def\s+\w+\s*\(/);
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
    const indent = lineText.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= defIndent) {
      endLine = line - 1;
      break;
    }
  }
  while (endLine > defLine && lines[endLine].trim() === '') endLine--;

  return { startLine: defLine, endLine };
}

/**
 * C++ equivalent. Braces delimit the body rather than indentation, so this scans upward for a line
 * that looks like a function definition header and then matches braces forward to find its end.
 * Brace counting ignores braces inside string and character literals and inside comments, since a
 * `"}"` in a string would otherwise close the function early and truncate the selection.
 */
export function findEnclosingCppFunctionRange(lines: string[], anchorLine: number): LineRange | null {
  // A definition header: an identifier, a parameter list, and an opening brace on the same line or
  // the next one. Deliberately rejects control-flow keywords, which have the same shape.
  const HEADER = /^[A-Za-z_][\w:<>,\s*&]*\s+[A-Za-z_]\w*\s*\([^;]*\)\s*(const\s*)?\{?\s*$/;
  const NOT_A_FUNCTION = /^\s*(if|for|while|switch|catch|return|else|do)\b/;

  let defLine = -1;
  for (let line = anchorLine; line >= 0; line--) {
    const text = lines[line];
    if (text === undefined || text.trim() === '') continue;
    if (NOT_A_FUNCTION.test(text)) continue;
    if (HEADER.test(text.trimEnd())) {
      defLine = line;
      break;
    }
  }
  if (defLine === -1) return null;

  let depth = 0;
  let seenOpen = false;
  let inBlockComment = false;
  for (let line = defLine; line < lines.length; line++) {
    const text = lines[line];
    let inString: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (inBlockComment) {
        if (c === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inString) {
        if (c === '\\') i++;
        else if (c === inString) inString = null;
        continue;
      }
      if (c === '/' && next === '/') break;
      if (c === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        inString = c;
        continue;
      }
      if (c === '{') {
        depth++;
        seenOpen = true;
      } else if (c === '}') {
        depth--;
        if (seenOpen && depth === 0) return { startLine: defLine, endLine: line };
      }
    }
  }
  return seenOpen ? { startLine: defLine, endLine: lines.length - 1 } : null;
}
