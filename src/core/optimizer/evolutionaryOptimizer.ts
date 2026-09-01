import type { LLMProvider } from '../llm/llmProvider.js';
import { PythonAdapter } from '../lang/pythonAdapter.js';
import { DifferentialTestOracle } from '../fitness/testOracle/differential.js';
import { FitnessEvaluator } from '../fitness/fitnessEvaluator.js';
import { PatternRetriever } from '../pattern/patternRetriever.js';
import { buildInitialPrompt, buildIterationPrompt, parseGoCotResponse } from '../prompt/goCotPromptBuilder.js';
import type { Candidate } from '../fitness/types.js';

export interface OptimizerOptions {
  /** Representative sample count (Ns in the paper). Defaults to 3, matching the paper's own tuned
   *  optimum (§IV-D, Fig. 7) — their ablation shows both smaller and larger Ns measurably
   *  underperform this. An earlier version of this code retuned it down to 2 for "interactive
   *  latency," but that wasn't grounded in anything and just made the search worse; now that
   *  refineFurther() exists as a way to add more search on demand, there's no good reason to start
   *  below the paper's proven peak. */
  ns?: number;
  /** Defaults to 4, same reasoning — the paper's own tuned optimum, not an arbitrary retuning. */
  maxIterations?: number;
  /** Candidates sampled per iteration (the paper's `generation_number`; run.sh uses 4). Lowering
   *  it to 1 makes a run ~4x faster but degrades the search into a linear chain — the pool never
   *  grows past Ns, so representative selection has nothing to choose between and crossover has no
   *  distinct methods to combine. Exposed as a setting because a slow local model makes the
   *  paper-faithful default genuinely expensive in an interactive editor. */
  generationNumber?: number;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
  /** Everything the target function depends on but doesn't define itself — imports, module-level
   *  constants, earlier helper functions in the same file. Prepended when executing (so functions
   *  with real-world file dependencies actually run) and shown to the LLM as available context it
   *  must not redefine. Ignored on refineFurther() — only meaningful when building a fresh oracle. */
  contextPrefix?: string;
}

export interface OptimizerResult {
  best: Candidate;
  baselineTimeMs: number;
  history: Candidate[];
  publicCount: number;
  privateCount: number;
}

function explanationOf(parsed: { analysis: string; opportunities: string; explanation: string }): string {
  return [parsed.analysis, parsed.opportunities, parsed.explanation].filter(Boolean).join('\n\n');
}

/**
 * Ports Algorithm 2 (the evolutionary optimization process) from the paper. Stateful across calls:
 * `optimize()` builds a fresh test oracle and runs the initial search; `refineFurther()` reuses the
 * same oracle and candidate pool to keep iterating — this is what backs the "Refine Further" button,
 * so clicking it doesn't re-synthesize test inputs or throw away what's already been learned.
 */
export class EvolutionaryOptimizer {
  private readonly adapter: PythonAdapter;
  private readonly fitness: FitnessEvaluator;
  private readonly patterns = new PatternRetriever('python');

  private slowCode = '';
  private contextPrefix = '';
  private oracle: DifferentialTestOracle | null = null;
  private pool: Candidate[] = [];
  private previousRepresentativeKey: string | null = null;

  constructor(
    private readonly llm: LLMProvider,
    opts: { scriptsDir: string },
  ) {
    this.adapter = new PythonAdapter(opts.scriptsDir);
    this.fitness = new FitnessEvaluator(this.adapter);
  }

  async optimize(slowCode: string, opts: OptimizerOptions = {}): Promise<OptimizerResult> {
    const log = opts.onProgress ?? (() => {});

    const contextPrefix = opts.contextPrefix ?? '';

    log('Building differential test oracle from the original code...');
    const oracle = await DifferentialTestOracle.build(this.llm, this.adapter, slowCode, { contextPrefix });
    log(`Oracle ready: ${oracle.publicCount} public / ${oracle.privateCount} private test case(s).`);

    log('Generating seed candidate (no history yet)...');
    const seedResponse = await this.llm.generate(buildInitialPrompt(slowCode, contextPrefix), { signal: opts.signal });
    const seedParsed = parseGoCotResponse(seedResponse.text);
    const seedFitness = await oracle.evaluatePublic(seedParsed.code);
    log(
      `Seed: acc=${seedFitness.acc.toFixed(2)} speedup=${seedFitness.speedup.toFixed(2)}x` +
        (seedFitness.error ? ` error=${seedFitness.error}` : ''),
    );

    this.slowCode = slowCode;
    this.contextPrefix = contextPrefix;
    this.oracle = oracle;
    this.pool = [{ code: seedParsed.code, explanation: explanationOf(seedParsed), ...seedFitness }];
    this.previousRepresentativeKey = null;

    return this.runIterationsAndFinalize(opts);
  }

  async refineFurther(opts: OptimizerOptions = {}): Promise<OptimizerResult> {
    if (!this.oracle) {
      throw new Error('refineFurther() called before optimize() — no active session.');
    }
    // Without this reset, the convergence check below sees "representative set unchanged since
    // last time" as true on its very first comparison (nothing new has run yet) and immediately
    // declares convergence before generating a single new candidate — refineFurther() would
    // silently no-op and just hand back the same result.
    this.previousRepresentativeKey = null;
    return this.runIterationsAndFinalize(opts);
  }

  private async runIterationsAndFinalize(opts: OptimizerOptions): Promise<OptimizerResult> {
    const ns = opts.ns ?? 3;
    const maxIterations = opts.maxIterations ?? 4;
    const generationNumber = opts.generationNumber ?? 4;
    const log = opts.onProgress ?? (() => {});
    const oracle = this.oracle!;

    for (let iter = 1; iter <= maxIterations; iter++) {
      if (opts.signal?.aborted) {
        log('Cancelled — stopping and reporting the best candidate found so far.');
        break;
      }

      const representative = await this.fitness.selectRepresentative(this.pool, ns);
      const representativeKey = representative.map((c) => c.code).join(' ');
      const hasCorrect = representative.some((c) => c.acc === 1);

      if (representativeKey === this.previousRepresentativeKey && hasCorrect) {
        log(`Iteration ${iter}: representative samples unchanged and a correct candidate exists — converged.`);
        break;
      }
      this.previousRepresentativeKey = representativeKey;

      const retrieved = this.patterns.retrieve(
        this.slowCode,
        representative.map((c) => c.code),
      );
      const prompt = buildIterationPrompt(this.slowCode, representative, retrieved, this.contextPrefix);

      log(
        `Iteration ${iter}: generating ${generationNumber} candidate(s) from ${representative.length} representative sample(s)...`,
      );

      // The paper generates MULTIPLE candidates per iteration (run.sh: generation_number=4), not
      // one. That breadth is what makes the search evolutionary rather than a linear chain: the
      // pool needs more members than Ns for representative selection to actually have anything to
      // choose between, and it's what gives crossover distinct methods to combine. Sampling at
      // temperature 0.7 (the paper's setting) is what makes repeated calls on the same prompt
      // diverge.
      for (let g = 0; g < generationNumber; g++) {
        if (opts.signal?.aborted) break;

        const response = await this.llm.generate(prompt, { signal: opts.signal });

        let parsed: ReturnType<typeof parseGoCotResponse>;
        try {
          parsed = parseGoCotResponse(response.text);
        } catch {
          log(`Iteration ${iter}.${g + 1}: model response was not parseable, skipping.`);
          continue;
        }

        const candidateFitness = await oracle.evaluatePublic(parsed.code);
        this.pool.push({ code: parsed.code, explanation: explanationOf(parsed), ...candidateFitness });
        log(
          `Iteration ${iter}.${g + 1}: acc=${candidateFitness.acc.toFixed(2)} speedup=${candidateFitness.speedup.toFixed(2)}x` +
            (candidateFitness.error ? ` error=${candidateFitness.error}` : ''),
        );
      }
    }

    const ranked = await this.fitness.selectRepresentative(this.pool, this.pool.length);
    const bestOnPublic = ranked[0] ?? this.pool[0];

    log('Verifying the best candidate against held-out private test cases...');
    const privateFitness = await oracle.evaluatePrivate(bestOnPublic.code);
    const best: Candidate = { code: bestOnPublic.code, explanation: bestOnPublic.explanation, ...privateFitness };

    return {
      best,
      baselineTimeMs: oracle.baselineTimeMs,
      history: [...this.pool],
      publicCount: oracle.publicCount,
      privateCount: oracle.privateCount,
    };
  }
}
