export type LanguageId = 'python' | 'cpp';

export interface CallResult {
  ok: boolean;
  output?: unknown;
  /** Captured stdout from the call — part of a function's observable behavior, since some
   *  functions communicate only via print() and never return anything meaningful. */
  stdout?: string;
  /** The arguments' state after the call. A function whose effect is mutating its input (an
   *  in-place sort that returns None) is otherwise indistinguishable from one that does nothing. */
  argsAfter?: unknown;
  error?: string;
  timeMs: number;
  /** Present when a baselineCode was supplied to runBatch — the original function re-timed in the
   *  SAME process, immediately alongside this call, so both experience identical system
   *  conditions and the ratio between them isn't exposed to drift over a search session. */
  baselineTimeMs?: number;
}

export interface RunBatchResult {
  /** Set when nothing could be run at all: syntax/compile error, crash, timeout, missing toolchain. */
  compileError?: string;
  results?: CallResult[];
}

/** Statements dropped from the file context because they would have side effects when re-run. */
export interface PreparedContext {
  code: string;
  skipped: string[];
}

/**
 * What the language-independent half of the system (the test oracle, fitness evaluation, the
 * evolutionary loop) needs from a language. The paper evaluates on Python and C++ and describes the
 * method as language-agnostic, so the search machinery is written against this interface and knows
 * nothing about either language beyond it.
 */
export interface LanguageAdapter {
  readonly id: LanguageId;

  /** Normalizes identifiers and literals so structurally identical candidates collapse to one key —
   *  Algorithm 1's AST-abstraction dedup step. null when the code doesn't parse. */
  abstract(code: string): Promise<string | null>;
  /** Batched form of abstract(); one entry per input, in order. */
  abstractMany(codes: string[]): Promise<(string | null)[]>;

  /** Name of the (first) function defined in `code`. */
  extractFunctionName(code: string): string | null;
  /** Parameter names of `funcName` in `code` (of the first function when funcName is omitted).
   *  Looked up BY NAME on purpose: candidates often define a helper above the target function. */
  extractParamNames(code: string, funcName?: string): string[] | null;

  /** Reduces the code above the target function to what it can safely depend on. */
  prepareContext(prefix: string): Promise<PreparedContext>;

  /** Executes `code`'s target function against each input, timing it. When `baselineCode` is given,
   *  the original is re-timed in the SAME process alongside each call, so the ratio is measured
   *  under identical conditions rather than compared against a stale number.
   *
   *  Must never reject: crashes, timeouts and compile errors are reported via `compileError`. */
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
