import type { RunBatchResult } from './pythonAdapter.js';

export type LanguageId = 'python' | 'cpp';

/**
 * What the language-independent half of the system (the test oracle, fitness evaluation, the
 * evolutionary loop) needs from a language. The paper evaluates on Python and C++ and describes the
 * method as language-agnostic, so the search machinery is written against this interface and knows
 * nothing about either language beyond it.
 */
export interface LanguageAdapter {
  readonly id: LanguageId;

  /** Normalizes identifiers and literals so structurally identical candidates collapse to one key —
   *  Algorithm 1's AST-abstraction dedup step. */
  abstract(code: string): Promise<string | null>;

  extractFunctionName(code: string): string | null;
  extractParamNames(code: string): string[] | null;

  /** Executes `code`'s target function against each input, timing it. When `baselineCode` is given,
   *  the original is re-timed in the SAME process alongside each call, so the ratio is measured
   *  under identical conditions rather than compared against a stale number. */
  runBatch(
    code: string,
    funcName: string,
    inputs: unknown[][],
    timeoutMs?: number,
    baselineCode?: string,
  ): Promise<RunBatchResult>;
}

/** Per-language details used when talking to the model and when building prompts. */
export const LANGUAGE_META: Record<LanguageId, { label: string; fence: string; vscodeId: string }> = {
  python: { label: 'Python', fence: 'python', vscodeId: 'python' },
  cpp: { label: 'C++', fence: 'cpp', vscodeId: 'cpp' },
};
