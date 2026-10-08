import { DegenerateOutputError, type LLMProvider } from '../../llm/llmProvider.js';
import type { CallResult, LanguageAdapter, RunOptions } from '../../lang/languageAdapter.js';
import { PythonAdapter } from '../../lang/pythonAdapter.js';
import { buildRandomInputs, cppMutants, type Mutant } from './testStrength.js';
import { LANGUAGE_META } from '../../lang/languageAdapter.js';
import { deepAlmostEqual } from '../../util/deepAlmostEqual.js';
import { extractJson } from '../../util/json.js';
import { throwIfAborted } from '../../util/abort.js';
import type { Fitness } from '../types.js';

export type { Fitness } from '../types.js';

export interface OracleTestCase {
  args: unknown[];
  /** Return value, printed output and post-call argument state all count as "what this call
   *  produced" — a function that only print()s, or only mutates its input, would otherwise always
   *  compare equal (None == None) regardless of what it actually did. */
  expected: { output: unknown; stdout: string; argsAfter: unknown; raises?: string };
  /** Synthetic large input added so timing reflects asymptotic behaviour, not call overhead. */
  stress?: boolean;
}

export interface OracleBuildOptions {
  numInputs?: number;
  contextPrefix?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

const STRESS_SIZE = 2000;
const RANDOM_TESTS = 100;
const MUTANT_LIMIT = 10;
const MUTANT_TIMEOUT_MS = 20_000;
/** Errors that say "this input exhausted a resource", not "this input is invalid" — an optimized
 *  version that avoids them (iterative instead of deep recursion) must not be penalized. */
const RESOURCE_ERRORS = /^(RecursionError|MemoryError|SystemExit|KeyboardInterrupt|crashed|timed out)/;

export interface TestStrength {
  /** Valid (compilable) deliberate-bug variants of the original. */
  mutants: number;
  /** Caught by the search + held-out tests as originally generated. */
  killedInitially: number;
  /** Caught after adding the random inputs that exposed surviving bugs. */
  killed: number;
  /** Random inputs promoted into the test sets because they caught a bug the tests missed. */
  promotedInputs: number;
  /** Descriptions of bugs no test catches (may be equivalent mutants — same behaviour). */
  survivors: string[];
}
const BATCH_TIMEOUT_MS = 90_000;

/**
 * Tier 2 of the TestOracleStrategy from ARCHITECTURE.md §2.1: no PIE test cases exist for arbitrary
 * user code, so the original function is used as its own oracle. One LLM call synthesizes diverse
 * concrete inputs, the original runs once to capture ground truth, and the result is split into a
 * "public" set (used during iteration — the paper's public test cases) and a held-out "private" set
 * (final accept-gate only) to guard against overfitting to the tests seen during the search.
 */
export class DifferentialTestOracle {
  private publicTests: OracleTestCase[] = [];
  private privateTests: OracleTestCase[] = [];
  private baselineMs = 0;
  private originalParamNames: string[] = [];
  /** The original (slow) code with context prepended — re-timed alongside every candidate in the
   *  same subprocess call, instead of comparing against one measurement taken at the start. */
  private baselineCode = '';
  private readonly cache = new Map<string, Fitness>();
  /** Random tests: final gate only (never shown to the model, never used for ranking). */
  private randomTests: OracleTestCase[] = [];
  private readonly randomCache = new Map<string, { matched: number; total: number; failure?: string }>();
  private strength: TestStrength | null = null;

  private constructor(
    private readonly llm: LLMProvider,
    private readonly adapter: LanguageAdapter,
    readonly funcName: string,
    /** Everything the target function needs but doesn't define itself — imports, module-level
     *  constants, earlier helper functions — prepended before every execution. */
    private readonly contextPrefix: string,
  ) {}

  static async build(
    llm: LLMProvider,
    adapter: LanguageAdapter,
    slowCode: string,
    opts: OracleBuildOptions = {},
  ): Promise<DifferentialTestOracle> {
    const funcName = adapter.extractFunctionName(slowCode);
    if (!funcName) {
      throw new Error(
        adapter.id === 'python'
          ? 'Could not find a `def name(...)` in the provided code.'
          : 'Could not find a function definition in the provided C++ code.',
      );
    }

    const oracle = new DifferentialTestOracle(llm, adapter, funcName, opts.contextPrefix ?? '');
    oracle.originalParamNames = adapter.extractParamNames(slowCode, funcName) ?? [];
    await oracle.init(slowCode, opts.numInputs ?? 10, opts);
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

  /** Number of parameters of the original function — what every candidate must keep. */
  get paramCount(): number {
    return this.originalParamNames.length;
  }

  get baselineTimeMs(): number {
    return this.baselineMs;
  }

  private async init(slowCode: string, numInputs: number, opts: OracleBuildOptions): Promise<void> {
    const log = opts.onProgress ?? (() => {});
    this.baselineCode = this.withContext(slowCode);

    const generated = await this.generateInputs(slowCode, numInputs, opts.signal);
    throwIfAborted(opts.signal);
    const { kept: inputs, dropped } = filterToContract(generated);
    if (dropped.length > 0) {
      log(`${dropped.length} generated input(s) didn't match the shape of the others (e.g. nested or mixed-type lists) and were discarded.`);
    }

    const batch = await this.adapter.runBatch(this.baselineCode, this.funcName, inputs, BATCH_TIMEOUT_MS);
    if (batch.compileError || !batch.results) {
      throw new Error(`Could not execute the original code to build ground truth: ${batch.compileError}`);
    }

    const cases: OracleTestCase[] = [];
    const errorCases: OracleTestCase[] = [];
    const errorTypes = new Set<string>();
    let timeSum = 0;
    let discarded = 0;
    batch.results.forEach((r, i) => {
      if (r.ok) {
        cases.push({ args: inputs[i], expected: { output: r.output, stdout: r.stdout ?? '', argsAfter: r.argsAfter ?? null } });
        timeSum += r.timeMs;
      } else if (!RESOURCE_ERRORS.test(r.error ?? '') && !errorTypes.has(r.errorType ?? r.error ?? '') && errorCases.length < 3) {
        // Keep (a few distinct) inputs on which the original raises: a candidate must raise too,
        // rather than silently returning a value for input the original rejects.
        errorTypes.add(r.errorType ?? r.error ?? '');
        errorCases.push({ args: inputs[i], expected: { output: null, stdout: '', argsAfter: null, raises: r.errorType ?? 'an error' } });
      } else {
        discarded++;
      }
    });
    if (errorCases.length > 0) {
      log(`Kept ${errorCases.length} input(s) on which the original raises (${[...errorTypes].join(', ')}): candidates must raise too.`);
    }
    if (discarded > 0) log(`${discarded} other generated input(s) raised an error on the original code and were discarded.`);

    // Determinism: run the original again. If results differ, the function depends on randomness,
    // the clock or external state, and comparing two versions' outputs would be meaningless.
    if (cases.length > 0) {
      const again = await this.adapter.runBatch(this.baselineCode, this.funcName, cases.map((c) => c.args), BATCH_TIMEOUT_MS, undefined, { timing: false });
      const unstable = new Set<number>();
      cases.forEach((c, i) => {
        const r = again.results?.[i];
        if (r && !checkCase(r, c).match) unstable.add(i);
      });
      if (unstable.size > cases.length / 2) {
        throw new Error(
          `The function gives different results for the same input on ${unstable.size} of ${cases.length} inputs — it seems to ` +
            'depend on randomness, the clock or external state, so an optimized version cannot be checked against it.',
        );
      }
      if (unstable.size > 0) {
        for (let i = cases.length - 1; i >= 0; i--) if (unstable.has(i)) cases.splice(i, 1);
        log(`${unstable.size} input(s) gave different results on a second run of the original and were discarded.`);
      }
    }

    if (cases.length < 1) {
      const firstErr = batch.results.find((r) => !r.ok)?.error;
      throw new Error(
        'None of the generated inputs ran successfully on the original code — cannot build a test oracle.' +
          (firstErr ? ` First error: ${firstErr}` : ''),
      );
    }
    this.baselineMs = timeSum / cases.length;

    // Stress inputs run as their own batch: if the original is so slow on them that the batch times
    // out, they are dropped instead of taking the regular inputs down with them.
    const stressInputs = this.buildStressInputs(cases.map((c) => c.args));
    const stressCases: OracleTestCase[] = [];
    if (stressInputs.length > 0) {
      throwIfAborted(opts.signal);
      const sb = await this.adapter.runBatch(this.baselineCode, this.funcName, stressInputs, BATCH_TIMEOUT_MS);
      sb.results?.forEach((r, i) => {
        if (r.ok && r.timeMs < 5_000) {
          stressCases.push({
            args: stressInputs[i],
            expected: { output: r.output, stdout: r.stdout ?? '', argsAfter: r.argsAfter ?? null },
            stress: true,
          });
        }
      });
      if (stressCases.length > 0) log(`Added ${stressCases.length} large stress input(s) (${STRESS_SIZE} elements) for timing.`);
    }

    // Execution-based contract check. The stress inputs are flat lists the original just ran
    // successfully on, so they count as evidence too (in a real run, every model-generated list was
    // nested or mixed, and only the stress inputs proved flat lists work). They are never dropped.
    const structured = [...preferFlatLists([...cases.map((c) => c.args), ...stressCases.map((c) => c.args)])].filter(
      (i) => i < cases.length,
    );
    if (structured.length > 0 && structured.length < cases.length) {
      const drop = new Set(structured);
      for (let i = cases.length - 1; i >= 0; i--) if (drop.has(i)) cases.splice(i, 1);
      log(
        `${structured.length} input(s) with nested, dict or mixed-type lists were discarded: the original also ` +
          'accepts plain flat lists, so those are its real contract.',
      );
    }

    // Derived variants (reversed / with a duplicate) of the surviving inputs, with ground truth from
    // the original. Failures on the original just mean the variant is outside the contract.
    const augmented = this.augmentInputs(cases.map((c) => c.args));
    const augCases: OracleTestCase[] = [];
    if (augmented.length > 0) {
      throwIfAborted(opts.signal);
      const ab = await this.adapter.runBatch(this.baselineCode, this.funcName, augmented, BATCH_TIMEOUT_MS);
      ab.results?.forEach((r, i) => {
        if (r.ok) augCases.push({ args: augmented[i], expected: { output: r.output, stdout: r.stdout ?? '', argsAfter: r.argsAfter ?? null } });
      });
      if (augCases.length > 0) log(`Added ${augCases.length} derived input(s) (reversed / with a duplicate) to catch order or uniqueness assumptions.`);
    }

    // 70/30 public/private split of the regular cases; derived and stress cases alternate between
    // the two, so both sets contain unsorted inputs, inputs with duplicates, and a large input. The
    // first stress case goes to PUBLIC: speedups during the search must be measured on an input big
    // enough to show asymptotic differences.
    const splitAt = Math.max(1, Math.ceil(cases.length * 0.7));
    this.publicTests = cases.slice(0, splitAt);
    this.privateTests = cases.slice(splitAt);
    augCases.forEach((c, i) => (i % 2 === 0 ? this.privateTests : this.publicTests).push(c));
    stressCases.forEach((c, i) => (i % 2 === 0 ? this.publicTests : this.privateTests).push(c));
    errorCases.forEach((c, i) => (i % 2 === 0 ? this.publicTests : this.privateTests).push(c));

    throwIfAborted(opts.signal);
    await this.buildRandomTests(cases.map((c) => c.args), log, numericConstants(slowCode));
    throwIfAborted(opts.signal);
    await this.measureTestStrength(slowCode, log);
    if (this.privateTests.length === 0) {
      // Too few cases to hold any out — re-verify on the public ones rather than on nothing.
      this.privateTests = [...this.publicTests];
    }
  }

  private async generateInputs(slowCode: string, numInputs: number, signal?: AbortSignal): Promise<unknown[][]> {
    const paramNames = this.adapter.extractParamNames(slowCode, this.funcName);

    // A zero-parameter function has exactly one possible call — asking the LLM to invent
    // "diverse inputs" for it has no right answer and invites fake arguments.
    if (paramNames && paramNames.length === 0) return [[]];

    const lang = LANGUAGE_META[this.adapter.id];
    const example =
      paramNames && paramNames.length === 1
        ? `Example: for a function taking one parameter \`${paramNames[0]}\` called with the list [1, 2, 3], the entry is [[1, 2, 3]] — ` +
          `an array of ONE positional argument, whose value happens to be the list [1, 2, 3]. Do NOT write [1, 2, 3] ` +
          `directly as the entry — that would be read as three separate arguments.`
        : `Example: for a function taking two parameters called with (1, 2), the entry is [1, 2].`;

    const prompt = {
      system: `You generate test inputs for ${lang.label} functions. Reply with strict JSON only, no markdown, no commentary.`,
      user: [
        `Given this ${lang.label} function:`,
        '```' + lang.fence,
        slowCode,
        '```',
        '',
        `Generate ${numInputs} diverse test inputs for calling \`${this.funcName}\`, including edge cases`,
        '(empty/zero/negative/large values where sensible for the inferred parameter types), and at least',
        'two inputs of moderate size (e.g. 50-200 elements for collections) so performance differences show.',
        '',
        'IMPORTANT — inputs must represent how this function is actually MEANT to be called, not',
        `every exotic value ${lang.label} would technically permit. Specifically:`,
        '- Infer the intended element type from the code and stay consistent with it. If it',
        '  compares or sums elements, use plain numbers; if it concatenates them, use strings.',
        '- Do NOT nest containers (no lists of lists) unless the signature clearly calls for it.',
        '- Do NOT mix incompatible element types in one collection.',
        '- Keep inputs small enough that the ORIGINAL code finishes within a second.',
        `Inputs that are valid ${lang.label} but outside the intended contract make correct optimizations`,
        'look wrong (e.g. an unhashable list element rules out any set-based rewrite).',
        '',
        `The function has ${paramNames ? paramNames.length : 'its declared number of'} parameter(s)` +
          (paramNames ? `: ${paramNames.join(', ')}.` : '.'),
        'Reply with strict JSON only: {"inputs": [[arg1, arg2, ...], ...]}',
        "Each inner array is one call's positional arguments, in order, as JSON-serializable values.",
        example,
      ].join('\n'),
    };

    let inputs: unknown[] | null = null;
    let lastText = '';
    for (let attempt = 0; attempt < 2 && !inputs; attempt++) {
      throwIfAborted(signal);
      let response;
      try {
        response = await this.llm.generate(prompt, { temperature: attempt === 0 ? 0.9 : 0.4, signal, maxTokens: 3000 });
      } catch (err) {
        // A looping reply is just a failed attempt; retry (at a lower temperature).
        if (err instanceof DegenerateOutputError) {
          lastText = '(the model got stuck repeating itself)';
          continue;
        }
        throw err;
      }
      lastText = response.text;
      // Safe ONLY here: this response is pure literal data, never source code, so replacing
      // Python's None/True/False with JSON's null/true/false can't corrupt anything semantic.
      const parsed = extractJson(normalizePythonLiterals(response.text));
      // Smaller/local models sometimes return a bare top-level array instead of {"inputs": [...]}.
      inputs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.inputs) ? parsed.inputs : null;
      // A reply cut off by the token limit (small models sometimes start an endless list) still
      // holds complete entries before the cut — use those rather than failing outright.
      if (!inputs) {
        const salvaged = salvageInputEntries(normalizePythonLiterals(response.text));
        if (salvaged.length >= 3) inputs = salvaged;
      }
    }
    if (!inputs) {
      throw new Error(`The model did not return valid test-input JSON: ${lastText.slice(0, 200)}`);
    }

    const arity = paramNames && !paramNames.some((p) => p.startsWith('*')) ? paramNames.length : null;
    const fixed: unknown[][] = inputs
      .map((entry) => {
        // A single-parameter function whose one list argument got flattened into the entry.
        if (arity === 1) return Array.isArray(entry) && entry.length === 1 ? entry : [entry];
        return Array.isArray(entry) ? entry : [entry];
      })
      .filter((entry) => arity === null || entry.length === arity);

    if (fixed.length === 0) {
      throw new Error(`None of the generated inputs had the right number of arguments (${arity}).`);
    }
    return fixed;
  }

  /**
   * Asking a model for "large" inputs rarely produces anything big enough for a speedup to mean
   * anything. Takes the generated input with the longest list argument(s) and builds four large
   * variants of the same element type:
   *   0. ascending, all distinct      (public — timing without early exits)
   *   1. shuffled, all distinct       (held-out)
   *   2. shuffled, one duplicate      (public)
   *   3. descending, one duplicate    (held-out)
   * The duplicate/order variants matter for correctness, not just timing: with only sorted or only
   * distinct data, a wrong candidate like "return False if the list isn't sorted" passed every test
   * in a real run. The duplicated value sits at the far end, so an early-exit check still does real work.
   */
  private buildStressInputs(inputs: unknown[][]): unknown[][] {
    const longest = (entry: unknown[]) => Math.max(0, ...entry.map((a) => (Array.isArray(a) ? a.length : 0)));
    const template = [...inputs].sort((a, b) => longest(b) - longest(a))[0];
    if (!template || longest(template) === 0) return [];

    const variant = (shuffle: boolean, descending: boolean, duplicate: boolean): unknown[] | null => {
      const base = scaled(shuffle);
      if (!base) return null;
      return base.map((arg) => {
        if (!Array.isArray(arg) || arg.length < 2) return arg;
        const v = descending ? [...arg].reverse() : [...arg];
        if (duplicate) v[v.length - 1] = v[0];
        return v;
      });
    };

    const scaled = (shuffle: boolean): unknown[] | null => {
      const out: unknown[] = [];
      for (const arg of template) {
        if (!Array.isArray(arg) || arg.length === 0) {
          out.push(arg);
          continue;
        }
        const sample = arg.find((v) => v !== null && v !== undefined);
        let gen: (i: number) => unknown;
        if (typeof sample === 'number') {
          gen = Number.isInteger(sample) ? (i) => i : (i) => i + 0.5;
        } else if (typeof sample === 'string') {
          gen = (i) => `s${i}`;
        } else if (typeof sample === 'boolean') {
          gen = (i) => i % 2 === 0;
        } else {
          return null; // nested/unknown element shape — don't guess
        }
        const values = Array.from({ length: STRESS_SIZE }, (_, i) => gen(i));
        if (shuffle) {
          // Deterministic pseudo-shuffle (LCG), so results are reproducible across runs.
          let seed = 12345;
          for (let i = values.length - 1; i > 0; i--) {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            const j = seed % (i + 1);
            [values[i], values[j]] = [values[j], values[i]];
          }
        }
        out.push(values);
      }
      return out;
    };

    return [variant(false, false, false), variant(true, false, false), variant(true, false, true), variant(false, true, true)].filter(
      (x): x is unknown[] => x !== null,
    );
  }

  /**
   * Derived small inputs: for each generated input with a flat list argument, the same list
   * reversed, and with its first element duplicated at the end. A model-generated test set tends to
   * be "nice" (sorted, distinct); these cheap variants catch candidates that silently assume
   * sortedness or uniqueness. The original's behaviour on them is the ground truth, as always.
   */
  private augmentInputs(inputs: unknown[][], max = 8): unknown[][] {
    const seen = new Set(inputs.map((e) => JSON.stringify(e)));
    const out: unknown[][] = [];
    const push = (e: unknown[]) => {
      const k = JSON.stringify(e);
      if (!seen.has(k) && out.length < max) {
        seen.add(k);
        out.push(e);
      }
    };
    for (const entry of inputs) {
      entry.forEach((arg, i) => {
        if (!Array.isArray(arg) || arg.length < 2 || !/^list<(num|str|bool)>$/.test(shapeOf(arg))) return;
        const withArg = (v: unknown[]) => entry.map((a, k) => (k === i ? v : a));
        push(withArg([...arg].reverse()));
        push(withArg([...arg, arg[0]]));
      });
    }
    return out;
  }

  async evaluatePublic(code: string): Promise<Fitness> {
    return this.cached(`public\0${code}`, () => this.evaluateAgainst(code, this.publicTests));
  }

  async evaluatePrivate(code: string): Promise<Fitness> {
    return this.cached(`private\0${code}`, () => this.evaluateAgainst(code, this.privateTests));
  }

  get randomCount(): number {
    return this.randomTests.length;
  }

  get testStrength(): TestStrength | null {
    return this.strength;
  }

  /** Runs `code` on `tests` without timing; returns how many behaved identically and the first
   *  failure (input + reason), or a whole-batch error. */
  private async checkOnly(
    code: string,
    tests: OracleTestCase[],
    options: RunOptions = {},
  ): Promise<{ matched: number; total: number; failure?: string }> {
    if (tests.length === 0) return { matched: 0, total: 0 };
    const batch = await this.adapter.runBatch(this.withContext(code), this.funcName, tests.map((t) => t.args), BATCH_TIMEOUT_MS, undefined, {
      timing: false,
      ...options,
    });
    if (batch.compileError || !batch.results) return { matched: 0, total: tests.length, failure: batch.compileError ?? 'no results' };
    let matched = 0;
    let failure: string | undefined;
    tests.forEach((t, i) => {
      const r = batch.results![i];
      const check = r ? checkCase(r, t) : { match: false, reason: 'no result (crashed?)' };
      if (check.match) matched++;
      else failure ??= `on input ${previewArgs(t.args)}: ${check.reason}`;
    });
    return { matched, total: tests.length, failure };
  }

  /**
   * Final gate before a candidate may be applied: the random tests (for C++ together with all other
   * tests in a build with bounds-checked containers and undefined-behaviour traps, so a memory error
   * that happens to produce the right answer is caught).
   */
  async evaluateRandom(code: string): Promise<{ matched: number; total: number; failure?: string }> {
    const key = `random\0${code}`;
    const hit = this.randomCache.get(key);
    if (hit) return hit;
    const tests = this.adapter.id === 'cpp' ? [...this.publicTests, ...this.privateTests, ...this.randomTests] : this.randomTests;
    const res = await this.checkOnly(code, tests, { sanitize: this.adapter.id === 'cpp' });
    this.randomCache.set(key, res);
    return res;
  }

  /** Random inputs shaped like the real ones, with ground truth from the original. */
  private async buildRandomTests(examples: unknown[][], log: (m: string) => void, constants: number[]): Promise<void> {
    const inputs = buildRandomInputs(examples, RANDOM_TESTS, undefined, constants);
    if (inputs.length === 0) return;
    const batch = await this.adapter.runBatch(this.baselineCode, this.funcName, inputs, BATCH_TIMEOUT_MS, undefined, { timing: false });
    batch.results?.forEach((r, i) => {
      if (r.ok) {
        this.randomTests.push({ args: inputs[i], expected: { output: r.output, stdout: r.stdout ?? '', argsAfter: r.argsAfter ?? null } });
      } else if (!RESOURCE_ERRORS.test(r.error ?? '')) {
        this.randomTests.push({ args: inputs[i], expected: { output: null, stdout: '', argsAfter: null, raises: r.errorType ?? 'an error' } });
      }
    });
    if (this.randomTests.length > 0) log(`Built ${this.randomTests.length} random tests (shaped like the real inputs) for final verification.`);
  }

  /**
   * Mutation analysis: plants small deliberate bugs in the ORIGINAL (== -> !=, < -> <=, off-by-one,
   * and <-> or, ...) and checks that the search + held-out tests catch them. A bug the tests miss but
   * a random test catches promotes that random input into the tests. What survives everything is
   * reported: either a mutant that behaves identically (harmless) or a gap no test covers.
   */
  private async measureTestStrength(slowCode: string, log: (m: string) => void): Promise<void> {
    let mutants: Mutant[] = [];
    try {
      mutants =
        this.adapter instanceof PythonAdapter
          ? await this.adapter.mutants(slowCode, this.funcName, MUTANT_LIMIT)
          : cppMutants(slowCode, this.funcName, MUTANT_LIMIT);
    } catch {
      return;
    }
    if (mutants.length === 0) return;

    const tests = [...this.publicTests, ...this.privateTests];
    const random = this.randomTests;
    let valid = 0;
    let killedInitially = 0;
    let promoted = 0;
    const survivors: string[] = [];
    for (const m of mutants) {
      // Short limit: a planted bug easily turns a loop into an infinite one (< -> <=), and that
      // counts as caught anyway.
      const batch = await this.adapter.runBatch(this.withContext(m.code), this.funcName, [...tests, ...random].map((t) => t.args), MUTANT_TIMEOUT_MS, undefined, {
        timing: false,
      });
      if (batch.compileError && /error|Unsupported/i.test(batch.compileError) && !/timed out/.test(batch.compileError)) continue; // not a valid mutant
      valid++;
      const results = batch.results ?? [];
      const killedBy = (from: number, to: number) => {
        for (let i = from; i < to; i++) {
          const r = results[i];
          const t = i < tests.length ? tests[i] : random[i - tests.length];
          if (!r || !checkCase(r, t).match) return i;
        }
        return -1;
      };
      if (batch.compileError || killedBy(0, tests.length) !== -1) {
        killedInitially++;
        continue;
      }
      const hit = killedBy(tests.length, tests.length + random.length);
      if (hit !== -1) {
        // Promote the random input that exposed this bug, alternating between the two test sets.
        const t = random[hit - tests.length];
        (promoted % 2 === 0 ? this.publicTests : this.privateTests).push(t);
        promoted++;
      } else {
        survivors.push(m.description);
      }
    }
    if (valid === 0) return;
    this.strength = {
      mutants: valid,
      killedInitially,
      killed: valid - survivors.length,
      promotedInputs: promoted,
      survivors,
    };
    log(
      `Test strength: the tests catch ${this.strength.killed} of ${valid} deliberately planted bugs` +
        (promoted ? ` (${promoted} random input(s) promoted into the tests to catch ones they missed)` : '') +
        (survivors.length ? `; not caught: ${survivors.slice(0, 3).join(', ')}${survivors.length > 3 ? ', …' : ''}` : '') +
        '.',
    );
  }

  /**
   * Execution-based semantic comparison for the Compare view: runs `code` and the original on EVERY
   * test input (public, held-out and stress) in one paired batch, and reports each case — the input,
   * both behaviours, whether they are identical (return value, printed output and argument state),
   * and both timings.
   */
  async compareDetailed(code: string): Promise<CaseComparison[]> {
    const all: { test: OracleTestCase; split: 'public' | 'private' }[] = [];
    for (const t of this.publicTests) all.push({ test: t, split: 'public' });
    for (const t of this.privateTests) if (!this.publicTests.includes(t)) all.push({ test: t, split: 'private' });

    const batch = await this.adapter.runBatch(
      this.withContext(code),
      this.funcName,
      all.map((a) => a.test.args),
      BATCH_TIMEOUT_MS,
      this.baselineCode,
    );
    return all.map(({ test, split }, i): CaseComparison => {
      const r = batch.results?.[i];
      const expected = test.expected.raises ? `raises ${test.expected.raises}` : previewBehaviour(test.expected.output, test.expected.stdout);
      if (!r) {
        return {
          split, stress: !!test.stress, input: previewArgs(test.args), expected, actual: null, match: false,
          reason: batch.compileError ?? 'no result for this input', originalMs: null, candidateMs: null,
        };
      }
      const check = checkCase(r, test);
      return {
        split,
        stress: !!test.stress,
        input: previewArgs(test.args),
        expected,
        actual: r.ok ? previewBehaviour(r.output, r.stdout ?? '') : `raises ${r.errorType ?? 'an error'}`,
        match: check.match,
        reason: check.match ? undefined : check.reason,
        originalMs: typeof r.baselineTimeMs === 'number' && r.baselineTimeMs >= 0 ? r.baselineTimeMs : null,
        candidateMs: r.ok ? r.timeMs : null,
      };
    });
  }

  private async cached(key: string, fn: () => Promise<Fitness>): Promise<Fitness> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const value = await fn();
    this.cache.set(key, value);
    return value;
  }

  private async evaluateAgainst(code: string, tests: OracleTestCase[]): Promise<Fitness> {
    const fail = (error: string): Fitness => ({ acc: 0, speedup: 1, avgTimeMs: null, baselineTimeMs: null, error });

    if (!code.trim()) return fail('the model returned no code');

    // Checked before executing: a model asked to "optimize" a function sometimes "improves" it by
    // parameterizing hardcoded values, which breaks the fixed calling convention every test relies
    // on. Count only, not names — calls are positional, so a harmless rename is fine. Looked up by
    // the target's NAME, so a helper defined above it is not mistaken for it.
    const candidateParams = this.adapter.extractParamNames(code, this.funcName);
    if (candidateParams === null) {
      return fail(`the code does not define a function named \`${this.funcName}\` — the name must stay the same`);
    }
    if (candidateParams.length !== this.originalParamNames.length) {
      return fail(
        `changed the function signature from (${this.originalParamNames.join(', ')}) to (${candidateParams.join(', ')}) — ` +
          'the number of parameters must stay exactly the same so it can be called the same way',
      );
    }

    // baselineCode is passed alongside the candidate so the ORIGINAL is re-timed in the same
    // subprocess, immediately after each candidate call. Comparing against a number measured
    // once at session start is what produced inconsistent speedups (1.04x vs 0.97x) for identical
    // code. The timeout allows for both functions being timed on every case.
    const batch = await this.adapter.runBatch(
      this.withContext(code),
      this.funcName,
      tests.map((t) => t.args),
      BATCH_TIMEOUT_MS,
      this.baselineCode,
    );
    if (batch.compileError || !batch.results) return fail(batch.compileError ?? 'unknown execution error');

    let matched = 0;
    let candSum = 0;
    let candCount = 0;
    let pairedCand = 0;
    let pairedBase = 0;
    let pairedCount = 0;
    let firstError: string | undefined;
    tests.forEach((t, i) => {
      const r = batch.results![i];
      if (!r) {
        firstError ??= 'no result for this input';
        return;
      }
      const check = checkCase(r, t);
      if (check.match) {
        matched++;
        if (!r.ok) return; // an expected error: correct, but not something to time
        candSum += r.timeMs;
        candCount++;
        if (typeof r.baselineTimeMs === 'number' && r.baselineTimeMs > 0) {
          // Sums over the SAME cases on both sides, so the ratio compares like with like. Larger
          // inputs dominate the sums — which is the point: they show asymptotic differences.
          pairedCand += r.timeMs;
          pairedBase += r.baselineTimeMs;
          pairedCount++;
        }
      } else if (!firstError) {
        firstError = `${check.reason}${t.stress ? ' (on the large stress input)' : ''}`;
      }
    });

    const acc = tests.length > 0 ? matched / tests.length : 0;
    const correct = acc === 1;
    const avgTimeMs = candCount > 0 ? candSum / candCount : null;
    let speedup = 1;
    let baselineTimeMs: number | null = null;
    if (correct && pairedCand > 0 && pairedBase > 0) {
      speedup = pairedBase / pairedCand;
      baselineTimeMs = pairedBase / pairedCount;
    } else if (correct && avgTimeMs && avgTimeMs > 0) {
      // Pairing failed (the original could not be reloaded) — fall back to the session baseline.
      speedup = this.baselineMs / avgTimeMs;
      baselineTimeMs = this.baselineMs;
    }

    return { acc, speedup, avgTimeMs, baselineTimeMs, error: correct ? undefined : firstError };
  }
}

export interface CaseComparison {
  split: 'public' | 'private';
  stress: boolean;
  /** Short, human-readable renderings for display. */
  input: string;
  expected: string;
  actual: string | null;
  match: boolean;
  reason?: string;
  originalMs: number | null;
  candidateMs: number | null;
}

/** Whether a call result behaves identically to the ground truth — the single definition of
 *  "correct" used both for scoring and for the Compare view. */
function checkCase(r: CallResult, t: OracleTestCase): { match: boolean; reason: string } {
  // The original raises on this input: the candidate must fail too, not quietly return a value.
  if (t.expected.raises) {
    return r.ok
      ? { match: false, reason: `returned a value where the original raises ${t.expected.raises}` }
      : { match: true, reason: '' };
  }
  if (!r.ok) return { match: false, reason: r.error ?? 'raised an error' };
  const expected = t.expected;
  if (!deepAlmostEqual(r.output, expected.output)) return { match: false, reason: 'return value did not match the original' };
  if ((r.stdout ?? '').trimEnd() !== expected.stdout.trimEnd()) {
    return { match: false, reason: 'printed output did not match the original' };
  }
  if (!deepAlmostEqual(r.argsAfter ?? null, expected.argsAfter ?? null)) {
    return { match: false, reason: 'the arguments were left in a different state than the original leaves them' };
  }
  return { match: true, reason: '' };
}

/** Compact display form of a value: long lists are elided, canonical sets/dicts shown naturally. */
export function previewValue(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}...` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (depth > 2) return '[…]';
    const shown = v.slice(0, 6).map((x) => previewValue(x, depth + 1));
    return `[${shown.join(', ')}${v.length > 6 ? `, … (${v.length} items)` : ''}]`;
  }
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.__set__)) return `set${previewValue(o.__set__, depth).replace(/^\[/, '{').replace(/\]$/, '}')}`;
  const entries = Object.entries(o).slice(0, 4).map(([k, x]) => `${JSON.stringify(k)}: ${previewValue(x, depth + 1)}`);
  return `{${entries.join(', ')}${Object.keys(o).length > 4 ? ', …' : ''}}`;
}

function previewArgs(args: unknown[]): string {
  return `(${args.map((a) => previewValue(a)).join(', ')})`;
}

function previewBehaviour(output: unknown, stdout: string): string {
  const out = previewValue(output);
  const printed = stdout.trim();
  return printed ? `${out}  · prints ${JSON.stringify(printed.length > 40 ? `${printed.slice(0, 37)}...` : printed)}` : out;
}

/** Coarse type of a JSON value, with list element types folded in: `[1, 2.5]` -> "list<num>",
 *  `[[1]]` -> "list<list<num>>", `[1, "a"]` -> "list<num|str>", `[]` -> "list<?>". */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) {
    if (v.length === 0 || depth > 3) return 'list<?>';
    const shapes = v.map((x) => shapeOf(x, depth + 1));
    // A list of only None values is its own (suspicious) shape; None mixed with values is a mix.
    if (shapes.every((s) => s === 'null')) return 'list<null>';
    const inner = [...new Set(shapes.filter((s) => s !== 'list<?>'))].sort();
    return `list<${inner.length ? inner.join('|') : '?'}>`;
  }
  return 'dict';
}

const FLAT_LIST = /^list<(num|str|bool)>$/;

function compatible(shape: string, majority: string): boolean {
  if (shape === majority || shape === 'null') return true;
  // An empty list fits any list contract.
  if (shape === 'list<?>' && majority.startsWith('list<')) return true;
  return false;
}

/**
 * Drops generated inputs whose argument shapes disagree with the majority of the generated inputs —
 * e.g. one list of lists, or one mixed-type list, among otherwise flat lists of numbers. Such an
 * input is almost always the model straying outside the function's real contract, and it rejects
 * every valid set- or sort-based rewrite (an `==` scan accepts unhashable or unorderable elements;
 * a set or sort does not). Observed in a real run: correct 5000x candidates all failed verification
 * because of one such input. Only applies with three or more inputs, so there is a real majority.
 */
export function filterToContract(inputs: unknown[][]): { kept: unknown[][]; dropped: unknown[][] } {
  if (inputs.length < 3) return { kept: inputs, dropped: [] };
  const arity = Math.max(...inputs.map((e) => e.length));
  const majority: (string | null)[] = [];
  for (let i = 0; i < arity; i++) {
    const counts = new Map<string, number>();
    for (const entry of inputs) {
      const s = shapeOf(entry[i]);
      if (s === 'null' || s === 'list<?>') continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const informative = [...counts.values()].reduce((a, b) => a + b, 0);
    // Only enforce a clear majority of the inputs that reveal a type (empty lists and nulls don't);
    // with no consensus, there's no contract to infer.
    majority.push(best && informative >= 3 && best[1] * 2 > informative ? best[0] : null);
  }
  // Flat-list contract: when flat, single-type lists (list<num>, list<str>, list<bool>) are at least
  // as common as structured ones for an argument, the structured ones — lists holding dicts, nested
  // lists, None, or a mix of types — are the model straying. This holds even without a majority
  // shape overall (real replies mix scalars, strings and lists freely), and it is exactly the class
  // of input that rejects every correct set- or sort-based rewrite. A function that really takes
  // nested lists (a matrix) gets mostly nested inputs, so the rule doesn't fire for it.
  const flatOnly: boolean[] = [];
  for (let i = 0; i < arity; i++) {
    let flat = 0;
    let structured = 0;
    for (const entry of inputs) {
      const s = shapeOf(entry[i]);
      if (FLAT_LIST.test(s)) flat++;
      else if (s.startsWith('list<') && s !== 'list<?>') structured++;
      else if (s === 'dict') structured++;
    }
    flatOnly.push(flat > 0 && flat >= structured);
  }

  const kept: unknown[][] = [];
  const dropped: unknown[][] = [];
  for (const entry of inputs) {
    const ok = entry.every((arg, i) => {
      const s = shapeOf(arg);
      if (flatOnly[i] && (s === 'dict' || (s.startsWith('list<') && s !== 'list<?>' && !FLAT_LIST.test(s)))) return false;
      return majority[i] === null || compatible(s, majority[i]!);
    });
    (ok ? kept : dropped).push(entry);
  }
  return kept.length > 0 ? { kept, dropped } : { kept: inputs, dropped: [] };
}

/**
 * Execution-based contract check, applied to inputs the ORIGINAL ran successfully on. If, for some
 * argument, a flat single-type list (list<num>/list<str>/list<bool>) works, then the function accepts
 * flat lists — and inputs holding nested lists, dicts, None or mixed types in that argument are the
 * model straying outside the intended contract (an `==` scan happens to tolerate them; any set- or
 * sort-based rewrite does not). A function that genuinely needs nested lists (a matrix) fails on a
 * flat list, so no flat input survives for it and nothing is dropped. Returns the indices to drop.
 */
export function preferFlatLists(argsList: unknown[][]): Set<number> {
  const drop = new Set<number>();
  if (argsList.length < 2) return drop;
  const arity = Math.max(...argsList.map((a) => a.length));
  for (let i = 0; i < arity; i++) {
    const shapes = argsList.map((a) => shapeOf(a[i]));
    if (!shapes.some((s) => FLAT_LIST.test(s))) continue;
    shapes.forEach((s, k) => {
      if (s === 'dict' || (s.startsWith('list<') && s !== 'list<?>' && !FLAT_LIST.test(s))) drop.add(k);
    });
  }
  // Never drop everything.
  return drop.size < argsList.length ? drop : new Set();
}

/**
 * Recovers the complete top-level entries of a truncated `{"inputs": [ e1, e2, e3, …` (or bare
 * `[ e1, e2, …`) reply: scans the outer array, and parses each element whose brackets close before
 * the text ends. The incomplete trailing element is dropped.
 */
export function salvageInputEntries(text: string): unknown[] {
  const key = text.search(/"inputs"\s*:/);
  let i = key >= 0 ? text.indexOf('[', key) : text.indexOf('[');
  if (i === -1) return [];
  i++; // inside the outer array
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      if (depth === 0) break; // end of the outer array
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* malformed element — skip it */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Numeric literals in the source (comments and strings excluded) — candidate boundary values. */
export function numericConstants(code: string): number[] {
  const stripped = code
    .replace(/#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, ' ');
  return [...new Set((stripped.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) ?? []).map(Number))];
}

function normalizePythonLiterals(text: string): string {
  return text.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
}
