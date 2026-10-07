import { DegenerateOutputError, type LLMProvider } from '../../llm/llmProvider.js';
import type { LanguageAdapter } from '../../lang/languageAdapter.js';
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
  expected: { output: unknown; stdout: string; argsAfter: unknown };
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
    let timeSum = 0;
    let failed = 0;
    batch.results.forEach((r, i) => {
      if (r.ok) {
        cases.push({ args: inputs[i], expected: { output: r.output, stdout: r.stdout ?? '', argsAfter: r.argsAfter ?? null } });
        timeSum += r.timeMs;
      } else {
        failed++;
      }
    });
    if (failed > 0) log(`${failed} generated input(s) raised an error on the original code and were discarded.`);

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
    const stressInputs = this.buildStressInputs(inputs);
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

    // 70/30 public/private split of the regular cases. Stress cases are split too, with the first
    // going to PUBLIC: speedups during the search must be measured on an input big enough to show
    // asymptotic differences. (Appending it last used to land it in the private set every time, so
    // the search only ever timed tiny inputs where call overhead dominates.)
    const splitAt = Math.max(1, Math.ceil(cases.length * 0.7));
    this.publicTests = cases.slice(0, splitAt);
    this.privateTests = cases.slice(splitAt);
    if (stressCases[0]) this.publicTests.push(stressCases[0]);
    if (stressCases[1]) this.privateTests.push(stressCases[1]);
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
   * anything. Takes the generated input with the longest list argument(s) and builds two large
   * variants (ascending and pseudo-shuffled) of the same element type, with distinct elements so
   * that, e.g., a duplicate check can't short-circuit on the first pair.
   */
  private buildStressInputs(inputs: unknown[][]): unknown[][] {
    const longest = (entry: unknown[]) => Math.max(0, ...entry.map((a) => (Array.isArray(a) ? a.length : 0)));
    const template = [...inputs].sort((a, b) => longest(b) - longest(a))[0];
    if (!template || longest(template) === 0) return [];

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

    return [scaled(false), scaled(true)].filter((x): x is unknown[] => x !== null);
  }

  async evaluatePublic(code: string): Promise<Fitness> {
    return this.cached(`public\0${code}`, () => this.evaluateAgainst(code, this.publicTests));
  }

  async evaluatePrivate(code: string): Promise<Fitness> {
    return this.cached(`private\0${code}`, () => this.evaluateAgainst(code, this.privateTests));
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
      const expected = t.expected;
      const stdoutMatches = (r.stdout ?? '').trimEnd() === expected.stdout.trimEnd();
      const outputMatches = deepAlmostEqual(r.output, expected.output);
      const argsMatch = deepAlmostEqual(r.argsAfter ?? null, expected.argsAfter ?? null);
      if (r.ok && outputMatches && stdoutMatches && argsMatch) {
        matched++;
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
        const where = t.stress ? ' (on the large stress input)' : '';
        firstError = !r.ok
          ? `${r.error}${where}`
          : !outputMatches
            ? `return value did not match the original${where}`
            : !stdoutMatches
              ? `printed output did not match the original${where}`
              : `the arguments were left in a different state than the original leaves them${where}`;
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

/** Coarse type of a JSON value, with list element types folded in: `[1, 2.5]` -> "list<num>",
 *  `[[1]]` -> "list<list<num>>", `[1, "a"]` -> "list<num|str>", `[]` -> "list<?>". */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) {
    if (v.length === 0 || depth > 3) return 'list<?>';
    const inner = [...new Set(v.map((x) => shapeOf(x, depth + 1)).filter((s) => s !== 'list<?>' && s !== 'null'))].sort();
    return `list<${inner.length ? inner.join('|') : '?'}>`;
  }
  return 'dict';
}

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
  const kept: unknown[][] = [];
  const dropped: unknown[][] = [];
  for (const entry of inputs) {
    const ok = entry.every((arg, i) => majority[i] === null || compatible(shapeOf(arg), majority[i]!));
    (ok ? kept : dropped).push(entry);
  }
  return kept.length > 0 ? { kept, dropped } : { kept: inputs, dropped: [] };
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

function normalizePythonLiterals(text: string): string {
  return text.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
}
