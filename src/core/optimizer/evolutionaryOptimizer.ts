import type { LLMProvider } from '../llm/llmProvider.js';
import { PythonAdapter } from '../lang/pythonAdapter.js';
import { CppAdapter } from '../lang/cppAdapter.js';
import type { LanguageAdapter, LanguageId } from '../lang/languageAdapter.js';
import { DifferentialTestOracle } from '../fitness/testOracle/differential.js';
import { FitnessEvaluator } from '../fitness/fitnessEvaluator.js';
import { PatternRetriever, type RetrievedPatterns } from '../pattern/patternRetriever.js';
import { buildInitialPrompt, buildIterationPrompt, parseGoCotResponse } from '../prompt/goCotPromptBuilder.js';
import type { Candidate, VerifiedCandidate } from '../fitness/types.js';
import type { Prompt } from '../llm/llmProvider.js';
import { CancelledError, isAbortError } from '../util/abort.js';
import { DegenerateOutputError } from '../llm/llmProvider.js';
import { repairCandidate } from './candidateRepair.js';
import { CodeAnalyzer } from '../analysis/analyzer.js';
import { sideBySide, syntacticSimilarity, type SideBySideRow, type SyntacticSimilarity } from '../compare/similarity.js';
import type { CaseComparison } from '../fitness/testOracle/differential.js';

export interface ComparisonReport {
  functionName: string;
  language: LanguageId;
  candidateId: number;
  original: string;
  candidate: string;
  rows: SideBySideRow[];
  syntactic: SyntacticSimilarity;
  semantic: {
    matched: number;
    total: number;
    /** Fraction of all test inputs on which both versions behave identically. */
    equivalence: number;
    cases: CaseComparison[];
  };
  complexity: { original: string | null; candidate: string | null };
  /** Total original time / total candidate time over all inputs (null unless all match). */
  speedup: number | null;
}

export interface OptimizerOptions {
  /** Representative sample count (Ns). Default 3 — the paper's tuned optimum (§IV-D, Fig. 7). */
  ns?: number;
  /** Maximum evolutionary iterations. Default 4 — the paper's tuned optimum. */
  maxIterations?: number;
  /** Candidates sampled per generation (the reference run.sh's generation_number = 4). Also the
   *  size of the initial population. Lowering it to 1 degrades the search into a linear chain. */
  generationNumber?: number;
  /** Minimum verified speedup for a result to count as an optimization. Default 1.1 — the paper's
   *  OPT metric only counts code "at least 10% faster" (§III-D), which also keeps measurement noise
   *  from being presented as an improvement. */
  minSpeedup?: number;
  /** How many of the top public-ranked candidates are re-verified on the private tests (the
   *  paper reports Top-1/3/5). Default 3. */
  topK?: number;
  onProgress?: (msg: string) => void;
  /** Called after every evaluated candidate, for live UI updates. */
  onCandidate?: (candidate: Candidate) => void;
  signal?: AbortSignal;
  /** Everything above the target function in its file. Reduced to side-effect-free statements
   *  (imports, definitions, constants) before use. Only read by optimize(). */
  contextPrefix?: string;
}

export type StopReason = 'converged' | 'max-iterations' | 'cancelled' | 'model-error';

export interface IterationRecord {
  iteration: number;
  representativeIds: number[];
  similarPattern?: string;
  differentPattern?: string;
  newCandidateIds: number[];
}

export interface OptimizerResult {
  /** Best finalist that is correct on the held-out private tests, or null when none is. */
  best: VerifiedCandidate | null;
  /** True when `best` is correct AND at least `minSpeedup` faster — the only case in which the
   *  extension offers to apply it. */
  improved: boolean;
  minSpeedup: number;
  /** Top-k public candidates re-measured on the private tests, best first. */
  finalists: VerifiedCandidate[];
  baselineTimeMs: number;
  /** Every candidate evaluated this session, in order (index === id). */
  history: Candidate[];
  iterations: IterationRecord[];
  stopReason: StopReason;
  publicCount: number;
  privateCount: number;
  contextSkipped: string[];
}

export interface OptimizerConfig {
  scriptsDir: string;
  language?: LanguageId;
  pythonPath?: string;
  cppCompiler?: string;
  /** Optional external pattern file (JSON/JSONL), e.g. mined from PIE's training split. */
  patternFile?: string;
}

function explanationOf(parsed: { analysis: string; opportunities: string; explanation: string }): string {
  return [parsed.analysis, parsed.opportunities, parsed.explanation].map((s) => s.trim()).filter(Boolean).join('\n\n');
}

/**
 * Algorithm 2 of the paper (§II-E), the evolutionary optimization process:
 *
 *   Sol <- initial solutions for s_t                     (a CoT-generated population)
 *   for i in 1..I:
 *       RS_i <- Select(Sol); retrieve patterns P_i       (Algorithm 1)
 *       if RS_i == RS_{i-1} and RS_i contains a correct solution: break
 *       NC <- generate with the GO-COT prompt (RS_i, P_i)
 *       Sol <- RS_i ∪ NC
 *   re-rank Sol with the selection of Algorithm 1
 *
 * Stateful across calls: `optimize()` builds a fresh test oracle and runs the search;
 * `refineFurther()` keeps the same oracle and population and continues iterating — this backs the
 * "Refine Further" button.
 */
export class EvolutionaryOptimizer {
  readonly adapter: LanguageAdapter;
  private readonly fitness: FitnessEvaluator;
  private readonly patterns: PatternRetriever;
  private readonly analyzer: CodeAnalyzer;
  readonly language: LanguageId;

  private slowCode = '';
  private contextPrefix = '';
  private contextSkipped: string[] = [];
  private oracle: DifferentialTestOracle | null = null;
  /** The current population Sol. */
  private sol: Candidate[] = [];
  private history: Candidate[] = [];
  private iterations: IterationRecord[] = [];
  private iterationCounter = 0;
  private previousRepresentativeKey: string | null = null;

  constructor(
    private readonly llm: LLMProvider,
    config: OptimizerConfig,
  ) {
    this.language = config.language ?? 'python';
    this.adapter =
      this.language === 'cpp'
        ? new CppAdapter({ compiler: config.cppCompiler })
        : new PythonAdapter(config.scriptsDir, { pythonPath: config.pythonPath });
    this.fitness = new FitnessEvaluator(this.adapter);
    this.patterns = new PatternRetriever(this.adapter, { externalFile: config.patternFile });
    this.analyzer = new CodeAnalyzer({ scriptsDir: config.scriptsDir, pythonPath: config.pythonPath });
  }

  get hasSession(): boolean {
    return this.oracle !== null;
  }

  /**
   * Side-by-side comparison of the original and a candidate: line alignment, syntactic similarity
   * (token and AST-structural), execution-based semantic similarity (behaviour on every test input,
   * with per-input timings), and the static complexity estimate of each.
   */
  async compare(candidate: Candidate): Promise<ComparisonReport> {
    const oracle = this.oracle;
    if (!oracle) throw new Error('compare() called before optimize() — no active session.');
    const [origAbs, candAbs] = await this.adapter.abstractMany([this.slowCode, candidate.code]).catch(() => [null, null]);
    const cases = await oracle.compareDetailed(candidate.code);
    const matched = cases.filter((c) => c.match);
    const sumOrig = matched.reduce((s, c) => s + (c.originalMs ?? 0), 0);
    const sumCand = matched.reduce((s, c) => s + (c.candidateMs ?? 0), 0);

    const complexityOf = async (code: string): Promise<string | null> => {
      try {
        const res = await this.analyzer.analyze(code, this.language);
        return res.functions.find((f) => f.name === oracle.funcName)?.complexity ?? null;
      } catch {
        return null;
      }
    };

    return {
      functionName: oracle.funcName,
      language: this.language,
      candidateId: candidate.id,
      original: this.slowCode,
      candidate: candidate.code,
      rows: sideBySide(this.slowCode, candidate.code),
      syntactic: syntacticSimilarity(this.slowCode, candidate.code, this.language, {
        original: origAbs ?? null,
        candidate: candAbs ?? null,
      }),
      semantic: {
        matched: matched.length,
        total: cases.length,
        equivalence: cases.length > 0 ? matched.length / cases.length : 0,
        cases,
      },
      complexity: { original: await complexityOf(this.slowCode), candidate: await complexityOf(candidate.code) },
      speedup: matched.length === cases.length && sumCand > 0 && sumOrig > 0 ? sumOrig / sumCand : null,
    };
  }

  async optimize(slowCode: string, opts: OptimizerOptions = {}): Promise<OptimizerResult> {
    const log = opts.onProgress ?? (() => {});
    const generationNumber = opts.generationNumber ?? 4;

    const funcName = this.adapter.extractFunctionName(slowCode);
    if (!funcName) throw new Error('No function definition found in the selected code.');
    if (this.adapter instanceof CppAdapter) {
      const unsupported = this.adapter.checkSupported(slowCode, funcName);
      if (unsupported) throw new Error(`This C++ function can't be benchmarked yet: ${unsupported}.`);
    }

    const prepared = await this.adapter.prepareContext(opts.contextPrefix ?? '');
    if (prepared.skipped.length > 0) {
      log(`Context: skipped ${prepared.skipped.length} top-level statement(s) with side effects (${prepared.skipped.slice(0, 3).join('; ')}${prepared.skipped.length > 3 ? '; …' : ''}).`);
    }

    log('Generating test inputs and capturing the original function’s behaviour…');
    const oracle = await DifferentialTestOracle.build(this.llm, this.adapter, slowCode, {
      contextPrefix: prepared.code,
      signal: opts.signal,
      onProgress: log,
    });
    log(`Test oracle ready: ${oracle.publicCount} public / ${oracle.privateCount} private test case(s).`);

    this.slowCode = slowCode;
    this.contextPrefix = prepared.code;
    this.contextSkipped = prepared.skipped;
    this.oracle = oracle;
    this.sol = [];
    this.history = [];
    this.iterations = [];
    this.iterationCounter = 0;
    this.previousRepresentativeKey = null;

    log(`Initial population: generating ${generationNumber} chain-of-thought candidate(s)…`);
    const seeds = await this.generateCandidates(
      buildInitialPrompt(this.language, slowCode, prepared.code),
      generationNumber,
      0,
      opts,
    );
    this.sol = seeds;
    if (seeds.length === 0) {
      if (opts.signal?.aborted) throw new CancelledError();
      throw new Error('The model did not produce any usable candidate for the initial population.');
    }

    return this.runIterationsAndFinalize(opts);
  }

  async refineFurther(opts: OptimizerOptions = {}): Promise<OptimizerResult> {
    if (!this.oracle) throw new Error('refineFurther() called before optimize() — no active session.');
    // Without this reset, the convergence check sees "representative set unchanged" on its first
    // comparison and stops before generating anything.
    this.previousRepresentativeKey = null;
    return this.runIterationsAndFinalize(opts);
  }

  /** Samples `count` responses for one prompt and evaluates each on the public tests. LLM and
   *  parsing failures skip that sample; cancellation stops early. Identical code is not
   *  re-added (its fitness is already known). */
  private async generateCandidates(prompt: Prompt, count: number, iteration: number, opts: OptimizerOptions): Promise<Candidate[]> {
    const log = opts.onProgress ?? (() => {});
    const oracle = this.oracle!;
    const out: Candidate[] = [];
    let lastLlmError: Error | null = null;
    const label = iteration === 0 ? 'Seed' : `Iteration ${iteration}`;

    for (let g = 0; g < count; g++) {
      if (opts.signal?.aborted) break;
      let text: string;
      try {
        text = (await this.llm.generate(prompt, { signal: opts.signal })).text;
      } catch (err) {
        if (isAbortError(err, opts.signal)) break;
        if (err instanceof DegenerateOutputError) {
          // An unusable sample, not a broken connection — don't let it count as a model failure.
          log(`${label}.${g + 1}: the model got stuck repeating itself; stopped it early and skipped this sample.`);
          continue;
        }
        lastLlmError = err as Error;
        log(`${label}.${g + 1}: the model call failed — ${(err as Error).message}`);
        continue;
      }

      let parsed: ReturnType<typeof parseGoCotResponse>;
      try {
        parsed = parseGoCotResponse(text);
      } catch {
        log(`${label}.${g + 1}: the response contained no usable code, skipping.`);
        continue;
      }

      const repaired = await repairCandidate(parsed.code, {
        adapter: this.adapter,
        funcName: oracle.funcName,
        arity: oracle.paramCount,
        contextPrefix: this.contextPrefix,
      });
      if (repaired.notes.length > 0) log(`${label}.${g + 1}: auto-repaired — ${repaired.notes.join('; ')}.`);
      const code = repaired.code;

      const existing = [...this.history].find((c) => c.code.trim() === code.trim());
      if (existing) {
        log(`${label}.${g + 1}: identical to #${existing.id}, skipping.`);
        continue;
      }

      const f = await oracle.evaluatePublic(code);
      const candidate: Candidate = {
        id: this.history.length,
        code,
        explanation: explanationOf(parsed),
        iteration,
        ...f,
      };
      this.history.push(candidate);
      out.push(candidate);
      opts.onCandidate?.(candidate);
      log(
        `${label}.${g + 1} → #${candidate.id}: ` +
          (f.acc === 1 ? `correct, ${f.speedup.toFixed(2)}x` : `acc=${f.acc.toFixed(2)}${f.error ? ` (${f.error})` : ''}`),
      );
    }

    if (out.length === 0 && lastLlmError && !opts.signal?.aborted) throw lastLlmError;
    return out;
  }

  private async runIterationsAndFinalize(opts: OptimizerOptions): Promise<OptimizerResult> {
    const ns = opts.ns ?? 3;
    const maxIterations = opts.maxIterations ?? 4;
    const generationNumber = opts.generationNumber ?? 4;
    const log = opts.onProgress ?? (() => {});
    let stopReason: StopReason = 'max-iterations';

    for (let step = 1; step <= maxIterations; step++) {
      if (opts.signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
      const iteration = ++this.iterationCounter;

      const representative = await this.fitness.selectRepresentative(this.sol, ns);
      const key = representative.map((c) => c.id).join(',');
      if (key === this.previousRepresentativeKey && representative.some((c) => c.acc === 1)) {
        log(`Iteration ${iteration}: representative samples unchanged and a correct solution exists — converged.`);
        this.iterationCounter--;
        stopReason = 'converged';
        break;
      }
      this.previousRepresentativeKey = key;

      let retrieved: RetrievedPatterns = { similar: null, different: null };
      try {
        retrieved = await this.patterns.retrieve(
          this.slowCode,
          representative.map((c) => c.code),
        );
      } catch (err) {
        log(`Pattern retrieval failed (${(err as Error).message}); continuing without patterns.`);
      }
      log(
        `Iteration ${iteration}: RS = {${representative.map((c) => `#${c.id}`).join(', ')}}` +
          (retrieved.similar ? `, similar pattern "${retrieved.similar.pattern.id}"` : '') +
          (retrieved.different ? `, different pattern "${retrieved.different.pattern.id}"` : '') +
          ` — generating ${generationNumber} candidate(s)…`,
      );

      const prompt = buildIterationPrompt(this.language, this.slowCode, representative, retrieved, this.contextPrefix);
      let fresh: Candidate[] = [];
      try {
        fresh = await this.generateCandidates(prompt, generationNumber, iteration, opts);
      } catch (err) {
        // Every model call in this iteration failed (and not by cancellation): stop the search but
        // still report what was found so far.
        log(`Stopping: ${(err as Error).message}`);
        stopReason = 'model-error';
        this.iterations.push({ iteration, representativeIds: representative.map((c) => c.id), newCandidateIds: [] });
        break;
      }

      this.iterations.push({
        iteration,
        representativeIds: representative.map((c) => c.id),
        similarPattern: retrieved.similar?.pattern.id,
        differentPattern: retrieved.different?.pattern.id,
        newCandidateIds: fresh.map((c) => c.id),
      });
      // Algorithm 2, line 9: Sol <- RS_i ∪ NC.
      this.sol = [...representative, ...fresh];

      if (opts.signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
    }

    if (stopReason === 'cancelled' && opts.signal?.aborted) {
      log('Cancelled — verifying and reporting the best candidate found so far.');
    }
    return this.finalize(opts, stopReason);
  }

  private async finalize(opts: OptimizerOptions, stopReason: StopReason): Promise<OptimizerResult> {
    const log = opts.onProgress ?? (() => {});
    const oracle = this.oracle!;
    const minSpeedup = opts.minSpeedup ?? 1.1;
    const topK = opts.topK ?? 3;

    // Algorithm 2, line 11: re-rank Sol with the selection part of Algorithm 1. Only candidates that
    // were fully correct on the public tests are eligible — a candidate that failed them must never
    // become "best" just because it happens to pass a small private set.
    const ranked = await this.fitness.selectRepresentative(this.sol, this.sol.length);
    const eligible = ranked.filter((c) => c.acc === 1).slice(0, topK);

    const finalists: VerifiedCandidate[] = [];
    if (eligible.length > 0) {
      log(`Verifying the top ${eligible.length} candidate(s) on ${oracle.privateCount} held-out private test case(s)…`);
    }
    const verify = async (cands: Candidate[]) => {
      for (const c of cands) {
        const priv = await oracle.evaluatePrivate(c.code);
        finalists.push({ ...c, ...priv, publicAcc: c.acc, publicSpeedup: c.speedup });
        if (priv.acc !== 1) log(`#${c.id} failed the held-out tests: ${priv.error ?? 'output did not match'}`);
      }
    };
    await verify(eligible);

    // If every top candidate fails the held-out tests, keep going down the list: a candidate ranked
    // lower on speed may still be correct, and stopping at the top 3 threw it away.
    if (!finalists.some((f) => f.acc === 1)) {
      const checked = new Set(finalists.map((f) => f.id));
      const rest = this.history
        .filter((c) => c.acc === 1 && !checked.has(c.id))
        .sort((a, b) => b.speedup - a.speedup)
        .slice(0, 6);
      if (rest.length > 0) {
        log(`None of the top ${eligible.length} passed — also checking ${rest.length} other candidate(s) that passed the search tests…`);
        await verify(rest);
      }
    }
    finalists.sort((a, b) => Number(b.acc === 1) - Number(a.acc === 1) || b.speedup - a.speedup);

    const best = finalists.find((f) => f.acc === 1) ?? null;
    const improved = best !== null && best.speedup >= minSpeedup;
    if (!best && finalists.length > 0) {
      log(
        `${finalists.length} candidate(s) passed the search tests but failed the held-out tests ` +
          `(first reason: ${finalists[0].error ?? 'output did not match'}). Try Refine Further.`,
      );
    } else if (!best) {
      log('No candidate was correct on both the public and the private tests.');
    } else if (!improved) {
      log(`Best correct candidate is #${best.id} at ${best.speedup.toFixed(2)}x — below the ${minSpeedup}x threshold, so it is not offered as an optimization.`);
    } else {
      log(`Best: #${best.id}, ${best.speedup.toFixed(2)}x faster on the held-out tests.`);
    }

    return {
      best,
      improved,
      minSpeedup,
      finalists,
      baselineTimeMs: oracle.baselineTimeMs,
      history: [...this.history],
      iterations: [...this.iterations],
      stopReason,
      publicCount: oracle.publicCount,
      privateCount: oracle.privateCount,
      contextSkipped: this.contextSkipped,
    };
  }
}
