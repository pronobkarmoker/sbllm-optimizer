import type { LanguageId } from '../lang/languageAdapter.js';
import { findCppFunctions } from '../lang/cpp/cppSource.js';

/**
 * Conservative token estimate for prompt budgeting. Measured with qwen2.5-coder's tokenizer on this
 * tool's real prompts: ~4.4 characters per token (code + English). 3.5 errs on the side of
 * over-estimating, so a prompt judged to fit really does fit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * The file context reduced to declarations: function/class bodies replaced by `...` (Python) or
 * `{ /* ... *\/ }` (C++), keeping imports, constants and signatures — what the model needs to know
 * exists, at a fraction of the size.
 */
export function signaturesOnly(lang: LanguageId, code: string): string {
  if (lang === 'cpp') {
    const fns = findCppFunctions(code);
    let out = code;
    for (const f of [...fns].sort((a, b) => b.bodyOpen - a.bodyOpen)) {
      out = out.slice(0, f.bodyOpen) + '{ /* ... */ }' + out.slice(f.bodyClose + 1);
    }
    return out;
  }
  const lines = code.split('\n');
  const out: string[] = [];
  let skippingIndent: number | null = null;
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)![1].length;
    if (skippingIndent !== null) {
      if (line.trim() === '' || indent > skippingIndent) continue;
      skippingIndent = null;
    }
    out.push(line);
    const header = line.match(/^(\s*)(?:async\s+)?(?:def|class)\s+\w+.*:\s*(#.*)?$/);
    if (header) {
      out.push(`${header[1]}    ...`);
      skippingIndent = header[1].length;
    }
  }
  return out.join('\n');
}

/** First `max` lines of `code`, with a marker when cut. */
export function truncateLines(code: string, max: number): string {
  const lines = code.trimEnd().split('\n');
  return lines.length <= max ? code.trimEnd() : [...lines.slice(0, max), `... (${lines.length - max} more lines)`].join('\n');
}
