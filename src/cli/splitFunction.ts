import type { LanguageId } from '../core/lang/languageAdapter.js';
import { findCppFunctions } from '../core/lang/cpp/cppSource.js';
import { findEnclosingFunctionRange } from '../core/lang/functionRange.js';

/** Splits a source file into (everything above the target function, the target function). The
 *  target is `name`, or the last optimizable top-level function in the file. */
export function split(text: string, language: LanguageId, name?: string): { prefix: string; code: string } | null {
  const lines = text.split('\n');
  if (language === 'cpp') {
    const fns = findCppFunctions(text).filter((f) => f.name !== 'main' && (!name || f.name === name));
    const fn = fns[fns.length - 1];
    if (!fn) return null;
    return { prefix: lines.slice(0, fn.startLine).join('\n'), code: lines.slice(fn.startLine, fn.endLine + 1).join('\n') };
  }
  const defs: number[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (m && (!name || m[1] === name)) defs.push(i);
  });
  const line = defs[defs.length - 1];
  if (line === undefined) return null;
  const range = findEnclosingFunctionRange(lines, line);
  if (!range) return null;
  return {
    prefix: lines.slice(0, range.startLine).join('\n'),
    code: lines.slice(range.startLine, range.endLine + 1).join('\n'),
  };
}
