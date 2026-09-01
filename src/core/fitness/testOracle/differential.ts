import type { LLMProvider } from '../../llm/llmProvider.js';
import type { PythonAdapter } from '../../lang/pythonAdapter.js';
import { deepAlmostEqual } from '../../util/deepAlmostEqual.js';
import { extractJson } from '../../util/json.js';

export interface OracleTestCase {
  args: unknown[];
  /** Both the return value AND the printed output count as "what this call produced" — a function
   *  that only print()s and never returns anything would otherwise always compare equal (None ==
   *  None) regardless of what it actually printed. */
  expected: { output: unknown; stdout: string };
}

export interface Fitness {
  acc: number;
  speedup: number;
  avgTimeMs: number | null;
  error?: string;
}

/**
 * Tier 2 of the TestOracleStrategy from ARCHITECTURE.md §2.1: no PIE test cases exist for arbitrary
 * user code, so the original function is used as its own oracle. One LLM call synthesizes diverse
 * concrete inputs, the original runs once to capture ground truth, and the result is split into a
 * "public" set (used during iteration, like the paper's public test cases) and a held-out "private"
 * set (final accept-gate only) to guard against overfitting to synthetic tests during the search.
 */
export class DifferentialTestOracle {
  private publicTests: OracleTestCase[] = [];
  private privateTests: OracleTestCase[] = [];
  private baselineMs = 0;
  private originalParamNames: string[] = [];
  /** The original (slow) code, with context prepended — kept so every later evaluation can re-time
   *  it alongside the candidate in the same subprocess call, instead of comparing against the single
   *  measurement taken once in init(). See the comment on evaluateAgainst() for why this matters. */
  private baselineCode = '';

  private constructor(
    private readonly llm: LLMProvider,
    private readonly adapter: PythonAdapter,
    private readonly funcName: string,
    /** Everything the target function needs but doesn't define itself — imports, module-level
     *  constants, earlier helper functions — prepended before every execution so functions that
     *  depend on file-level context (the common case for real code, not the isolated-snippet case
     *  the paper's PIE dataset assumes) actually run instead of failing on a NameError. */
    private readonly contextPrefix: string,
  ) {}

  static async build(
    llm: LLMProvider,
    adapter: PythonAdapter,
    slowCode: string,
    opts: { numInputs?: number; contextPrefix?: string } = {},
  ): Promise<DifferentialTestOracle> {
    const funcName = adapter.extractFunctionName(slowCode);
    if (!funcName) {
      throw new Error('Could not find a top-level `def name(...)` in the provided code.');
    }

    const oracle = new DifferentialTestOracle(llm, adapter, funcName, opts.contextPrefix ?? '');
    oracle.originalParamNames = adapter.extractParamNames(slowCode) ?? [];
    await oracle.init(slowCode, opts.numInputs ?? 10);
    return oracle;
  }

  private withContext(code: string): string {
    return this.contextPrefix ? `${this.contextPrefix}\n${code}` : code;
  }

  get publicCount(): number {
    return this.publicTests.length;
  }

  get privateCount(): number {
    return this.privateTests.length;
  }

  get baselineTimeMs(): number {
    return this.baselineMs;
  }

  private async init(slowCode: string, numInputs: number): Promise<void> {
    this.baselineCode = this.withContext(slowCode);
    const inputs = await this.generateInputs(slowCode, numInputs);
    // 30s not 20s: each call can now take up to MAX_TOTAL_TRIAL_TIME_S (2s) for multi-trial
    // timing (run_candidate.py), so a batch of several slow test cases needs more headroom.
    const batch = await this.adapter.runBatch(this.baselineCode, this.funcName, inputs, 30_000);
    if (batch.compileError || !batch.results) {
      throw new Error(`Could not execute the original code to build ground truth: ${batch.compileError}`);
    }

    const cases: OracleTestCase[] = [];
    let timeSum = 0;
    let timeCount = 0;
    batch.results.forEach((r, i) => {
      if (r.ok) {
        cases.push({ args: inputs[i], expected: { output: r.output, stdout: r.stdout ?? '' } });
        timeSum += r.timeMs;
        timeCount++;
      }
    });

    if (cases.length < 1) {
      throw new Error('None of the generated inputs ran successfully on the original code — cannot build a test oracle.');
    }

    this.baselineMs = timeCount > 0 ? timeSum / timeCount : 1;

    const splitAt = Math.max(1, Math.ceil(cases.length * 0.7));
    this.publicTests = cases.slice(0, splitAt);
    this.privateTests = cases.slice(splitAt);
    if (this.privateTests.length === 0) {
      this.privateTests = this.publicTests.slice(-1);
    }
  }

  private async generateInputs(slowCode: string, numInputs: number): Promise<unknown[][]> {
    const paramNames = this.adapter.extractParamNames(slowCode);

    // A zero-parameter function has exactly one possible call — asking the LLM to invent
    // "diverse inputs" for it has no right answer and, per the bug that surfaced this, an
    // LLM will readily invent fake arguments a no-arg function doesn't take. Skip the LLM
    // entirely here; there's nothing for it to legitimately vary.
    if (paramNames && paramNames.length === 0) {
      return [[]];
    }

    const example =
      paramNames && paramNames.length === 1
        ? `Example: for a function \`def f(${paramNames[0]}):\` called as f([1, 2, 3]), the entry is [[1, 2, 3]] — ` +
          `an array of ONE positional argument, whose value happens to be the list [1, 2, 3]. Do NOT write [1, 2, 3] ` +
          `directly as the entry — that would be read as three separate arguments.`
        : `Example: for a function \`def f(a, b):\` called as f(1, 2), the entry is [1, 2].`;

    const response = await this.llm.generate(
      {
        system: 'You generate test inputs for Python functions. Reply with strict JSON only, no markdown, no commentary.',
        user: [
          'Given this Python function:',
          '```python',
          slowCode,
          '```',
          '',
          `Generate ${numInputs} diverse test inputs for calling this function, including edge cases`,
          '(empty/zero/negative/large values where sensible for the inferred parameter types).',
          'Reply with strict JSON only: {"inputs": [[arg1, arg2, ...], ...]}',
          "Each inner array is one call's positional arguments, in order, as JSON-serializable values.",
          example,
        ].join('\n'),
      },
      { temperature: 0.9 },
    );

    // Safe ONLY here: this response is pure literal data (numbers/strings/lists), never source
    // code, so blanket-replacing Python's None/True/False for JSON's null/true/false can't corrupt
    // anything semantic — unlike in the GO-COT code path, where the same substitution could mangle
    // a legitimate `True`/`False`/`None` keyword inside actual candidate Python source.
    const parsed = extractJson(normalizePythonLiterals(response.text));
    // Smaller/local models sometimes ignore the {"inputs": [...]} wrapper and return a bare
    // top-level array instead — the nested per-call argument lists are still correct, so accept
    // both shapes rather than failing on a formatting detail the content itself got right.
    const inputs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.inputs) ? parsed.inputs : null;
    if (!inputs) {
      throw new Error(`LLM did not return valid test-input JSON: ${response.text.slice(0, 200)}`);
    }

    // Defends against the exact failure mode above surviving anyway: a single-parameter function
    // whose one list argument got flattened into the entry instead of nested inside it.
    const fixed: unknown[][] =
      paramNames && paramNames.length === 1
        ? inputs.map((entry: unknown[]) => (Array.isArray(entry) && entry.length === 1 ? entry : [entry]))
        : inputs;

    // Asking a small local model for "large" inputs rarely produces anything big enough for a
    // speedup measurement to mean anything — a hand-crafted worst-case sized input is more
    // reliable than hoping the model complies. Scoped to the single-list-param case for now,
    // matching where the auto-correction above is scoped.
    if (paramNames && paramNames.length === 1 && fixed.some((entry) => Array.isArray(entry[0]))) {
      fixed.push([Array.from({ length: 500 }, (_, i) => i)]);
    }

    return fixed;
  }

  async evaluatePublic(code: string): Promise<Fitness> {
    return this.evaluateAgainst(code, this.publicTests);
  }

  async evaluatePrivate(code: string): Promise<Fitness> {
    return this.evaluateAgainst(code, this.privateTests);
  }

  private async evaluateAgainst(code: string, tests: OracleTestCase[]): Promise<Fitness> {
    // Checked before ever executing: an LLM asked to "optimize" a function will sometimes
    // "improve" it by parameterizing hardcoded values, which breaks the fixed calling convention
    // every test case relies on. Rejecting this immediately, with a specific reason, gives the
    // next iteration's prompt something actionable to fix — a generic Python TypeError from a
    // botched call doesn't clearly communicate "you weren't supposed to change the signature."
    const candidateParamNames = this.adapter.extractParamNames(code);
    // Count only, not exact names — we always call positionally (func(*args)), so a harmless
    // rename (numbers -> nums) doesn't break anything and shouldn't be rejected; a different
    // *count* of parameters is what actually breaks every call every test case relies on.
    if (candidateParamNames && candidateParamNames.length !== this.originalParamNames.length) {
      return {
        acc: 0,
        speedup: 1,
        avgTimeMs: null,
        error: `changed the function signature from (${this.originalParamNames.join(', ')}) to (${candidateParamNames.join(', ')}) — the number of parameters must stay exactly the same so it can be called the same way`,
      };
    }

    // baselineCode is passed alongside the candidate so run_candidate.py re-times the ORIGINAL
    // function in the same subprocess, immediately after each candidate call — see the comment in
    // run_candidate.py's main(). This replaces comparing against this.baselineMs (measured once, in
    // its own process, at the very start of the session) with a same-moment, same-process pairing,
    // which is what was producing inconsistent speedups (e.g. 1.04x vs 0.97x) for identical code:
    // the candidate and the thing it was being compared against were never actually measured together.
    //
    // 60s not 30s: pairing means EVERY test case now times two functions instead of one — the
    // candidate AND a fresh baseline re-run — each individually bounded by run_candidate.py's own
    // MAX_TOTAL_TRIAL_TIME_S (2s). The baseline side matters here specifically: it's the ORIGINAL
    // (slow, by definition — that's the whole reason it's being optimized) function, so it's the
    // side most likely to actually consume its full 2s budget on every single test case, not an
    // edge case. Worst case is ~2x the un-paired timing budget across the whole batch; 30s stopped
    // being enough headroom the moment pairing was introduced.
    const batch = await this.adapter.runBatch(
      this.withContext(code),
      this.funcName,
      tests.map((t) => t.args),
      60_000,
      this.baselineCode,
    );
    if (batch.compileError || !batch.results) {
      return { acc: 0, speedup: 1, avgTimeMs: null, error: batch.compileError ?? 'unknown execution error' };
    }

    let matched = 0;
    let timeSum = 0;
    let pairedBaselineSum = 0;
    let pairedBaselineCount = 0;
    let firstError: string | undefined;
    batch.results.forEach((r, i) => {
      const expected = tests[i].expected;
      // trimEnd on stdout: tolerate trailing-newline/whitespace differences, not substantive ones.
      const stdoutMatches = (r.stdout ?? '').trimEnd() === expected.stdout.trimEnd();
      const outputMatches = deepAlmostEqual(r.output, expected.output);
      if (r.ok && outputMatches && stdoutMatches) {
        matched++;
        timeSum += r.timeMs;
        if (typeof r.baselineTimeMs === 'number' && r.baselineTimeMs > 0) {
          pairedBaselineSum += r.baselineTimeMs;
          pairedBaselineCount++;
        }
      } else if (!firstError) {
        firstError = r.ok
          ? stdoutMatches
            ? 'return value did not match the original for this input'
            : 'printed output did not match the original for this input'
          : r.error;
      }
    });

    const acc = matched / tests.length;
    const correct = acc === 1;
    const avgTimeMs = matched > 0 ? timeSum / matched : null;
    // Prefer the fresh, co-located baseline (same subprocess, same moment as the candidate) over
    // the stale this.baselineMs from init() — fall back only if pairing failed for every test case
    // (e.g. the original code itself somehow failed to load in run_candidate.py).
    const effectiveBaselineMs = pairedBaselineCount > 0 ? pairedBaselineSum / pairedBaselineCount : this.baselineMs;
    const speedup = correct && avgTimeMs !== null && avgTimeMs > 0 ? effectiveBaselineMs / avgTimeMs : 1;

    return { acc, speedup, avgTimeMs, error: correct ? undefined : firstError };
  }
}

function normalizePythonLiterals(text: string): string {
  return text.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
}
