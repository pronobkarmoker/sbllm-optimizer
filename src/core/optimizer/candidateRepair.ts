import type { LanguageAdapter } from '../lang/languageAdapter.js';
import { PythonAdapter } from '../lang/pythonAdapter.js';
import { findCppFunctions, stripMainFunction } from '../lang/cpp/cppSource.js';

export interface RepairResult {
  code: string;
  /** What was changed, for the progress log. Empty when nothing was. */
  notes: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definedFunctions(code: string, adapter: LanguageAdapter): string[] {
  if (adapter.id === 'cpp') return findCppFunctions(code).map((f) => f.name).filter((n) => n !== 'main');
  return [...code.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]);
}

/**
 * Mechanical fixes for mistakes small models make that have nothing to do with the optimization
 * itself, observed in real runs:
 *  - example usage left at module level (`numbers = [...]; print(f(numbers))`) or a C++ `main()`,
 *    which would otherwise run during evaluation and be pasted into the user's file on Apply;
 *  - the right function under a different name (often copied from an incorrect version shown in
 *    the prompt);
 *  - `lru_cache` / `Counter` / ... used without importing them.
 * These used to discard otherwise-correct candidates, or carry junk into the result. The repairs
 * only remove non-function code, rename, or add imports — they can't make wrong code look right,
 * because the result is still executed against the test oracle like any other candidate.
 */
export async function repairCandidate(
  code: string,
  opts: { adapter: LanguageAdapter; funcName: string; arity: number; contextPrefix: string },
): Promise<RepairResult> {
  const { adapter, funcName, arity } = opts;
  const notes: string[] = [];
  let out = code;

  // 1. C++: a main() the model added for demonstration.
  if (adapter.id === 'cpp') {
    const stripped = stripMainFunction(out);
    if (stripped.removed) {
      out = stripped.code.trim() + '\n';
      notes.push('removed a main() that is not part of the function');
    }
  }

  // 2. The target function under another name: rename the (last) function with the right arity.
  if (adapter.extractParamNames(out, funcName) === null) {
    const candidates = definedFunctions(out, adapter).filter((name) => adapter.extractParamNames(out, name)?.length === arity);
    const chosen = candidates[candidates.length - 1];
    if (chosen && chosen !== funcName) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(chosen)}\\b`, 'g'), funcName);
      notes.push(`renamed \`${chosen}\` back to \`${funcName}\``);
    }
  }

  // 3. Python: module-level example usage / prints, and well-known stdlib names used without an import.
  if (adapter instanceof PythonAdapter) {
    try {
      const res = await adapter.repairImports(out, opts.contextPrefix);
      if (res.removed > 0) notes.push(`removed ${res.removed} top-level statement(s) that aren't part of the function (example usage, prints)`);
      if (res.added.length > 0) notes.push(`added ${res.added.map((a) => `\`${a}\``).join(', ')}`);
      if (res.removed > 0 || res.added.length > 0) out = res.code;
    } catch {
      /* best effort — evaluation will report the NameError if there is one */
    }
  }

  return { code: out, notes };
}
