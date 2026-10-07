import type { LanguageAdapter } from '../lang/languageAdapter.js';
import { PythonAdapter } from '../lang/pythonAdapter.js';
import { findCppFunctions } from '../lang/cpp/cppSource.js';

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
 * itself, observed in real runs: answering with the right function under a different name (often
 * copied from an incorrect version shown in the prompt), and using `lru_cache` / `Counter` / ...
 * without importing them. Both used to discard an otherwise-correct candidate. The repairs only
 * rename or add imports — they can't make wrong code look right, because the result is still
 * executed against the test oracle like any other candidate.
 */
export async function repairCandidate(
  code: string,
  opts: { adapter: LanguageAdapter; funcName: string; arity: number; contextPrefix: string },
): Promise<RepairResult> {
  const { adapter, funcName, arity } = opts;
  const notes: string[] = [];
  let out = code;

  // 1. The target function under another name: rename the (last) function with the right arity.
  if (adapter.extractParamNames(out, funcName) === null) {
    const candidates = definedFunctions(out, adapter).filter((name) => adapter.extractParamNames(out, name)?.length === arity);
    const chosen = candidates[candidates.length - 1];
    if (chosen && chosen !== funcName) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(chosen)}\\b`, 'g'), funcName);
      notes.push(`renamed \`${chosen}\` back to \`${funcName}\``);
    }
  }

  // 2. Python: well-known standard-library names used without an import.
  if (adapter instanceof PythonAdapter) {
    try {
      const res = await adapter.repairImports(out, opts.contextPrefix);
      if (res.added.length > 0) {
        out = res.code;
        notes.push(`added ${res.added.map((a) => `\`${a}\``).join(', ')}`);
      }
    } catch {
      /* best effort — evaluation will report the NameError if there is one */
    }
  }

  return { code: out, notes };
}
