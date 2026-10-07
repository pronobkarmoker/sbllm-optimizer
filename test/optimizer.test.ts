import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionaryOptimizer } from '../src/core/optimizer/evolutionaryOptimizer.js';
import { HAS_PYTHON, SCRIPTS_DIR, ScriptedLLM, goCot } from './helpers.js';

const SLOW = `def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False`;

const FAST = `def has_duplicate(numbers):
    seen = set()
    for n in numbers:
        if n in seen:
            return True
        seen.add(n)
    return False`;

const FASTER = `def has_duplicate(numbers):
    return len(set(numbers)) != len(numbers)`;

const WRONG = `def has_duplicate(numbers):
    return False`;

const EXITS = `import sys
def has_duplicate(numbers):
    sys.exit(1)`;

const HELPER_FIRST = `def _distinct(xs):
    return len(set(xs))

def has_duplicate(numbers):
    return _distinct(numbers) != len(numbers)`;

const INPUTS = JSON.stringify({
  inputs: [[[1, 2, 3]], [[1, 2, 1]], [[]], [[5]], [[7, 7]], [[3, 1, 4, 1, 5]], [[10, 20, 30, 40]], [[-1, -2, -3, -1]]],
});

const noPy = !HAS_PYTHON && 'python not available';

test('end to end: finds and verifies a faster correct version; bad candidates never crash the run', { skip: noPy, timeout: 240_000 }, async () => {
  const llm = new ScriptedLLM(INPUTS, [goCot(WRONG), goCot(EXITS), goCot(FAST, 'use a set'), goCot(HELPER_FIRST), goCot(FASTER), 'not json and no code']);
  const opt = new EvolutionaryOptimizer(llm, { scriptsDir: SCRIPTS_DIR, language: 'python' });
  const seen: number[] = [];
  const result = await opt.optimize(SLOW, {
    ns: 3,
    maxIterations: 2,
    generationNumber: 3,
    onCandidate: (c) => seen.push(c.id),
    contextPrefix: 'import sys\nprint("side effect")\n',
  });

  assert.ok(result.best, 'expected a verified best candidate');
  assert.equal(result.best!.acc, 1);
  assert.ok(result.improved, `expected an improvement, got ${result.best!.speedup}x`);
  assert.ok(result.best!.speedup >= 1.1);
  assert.ok(result.finalists.every((f) => f.publicAcc === 1), 'only publicly-correct candidates are finalists');
  assert.deepEqual(seen, result.history.map((c) => c.id));
  assert.ok(result.contextSkipped.length === 1, 'the print() in the context is skipped');

  const wrong = result.history.find((c) => c.code === WRONG)!;
  assert.equal(wrong.acc < 1, true);
  const exits = result.history.find((c) => c.code === EXITS)!;
  assert.match(exits.error ?? '', /SystemExit/);
  // A helper defined above the target is not mistaken for a signature change.
  const helper = result.history.find((c) => c.code === HELPER_FIRST);
  if (helper) assert.equal(helper.acc, 1);

  // The GO-COT prompt was used for the iterations and carried retrieved patterns.
  const iterPrompt = llm.prompts.find((p) => p.user.includes('Some existing versions'));
  assert.ok(iterPrompt);
  assert.match(iterPrompt!.user, /Code transformation patterns/);
  assert.ok(result.iterations.length >= 1);
  assert.ok(result.iterations[0].similarPattern);
});

test('no correct candidate: best is null and nothing is offered', { skip: noPy, timeout: 120_000 }, async () => {
  const llm = new ScriptedLLM(INPUTS, [goCot(WRONG)]);
  const opt = new EvolutionaryOptimizer(llm, { scriptsDir: SCRIPTS_DIR, language: 'python' });
  const result = await opt.optimize(SLOW, { maxIterations: 2, generationNumber: 2 });
  assert.equal(result.best, null);
  assert.equal(result.improved, false);
});

test('cancellation mid-search reports results found so far instead of throwing', { skip: noPy, timeout: 120_000 }, async () => {
  const controller = new AbortController();
  const llm = new ScriptedLLM(INPUTS, [goCot(FAST), goCot(FASTER), goCot(WRONG)], (n) => {
    if (n === 3) controller.abort();
  });
  const opt = new EvolutionaryOptimizer(llm, { scriptsDir: SCRIPTS_DIR, language: 'python' });
  const result = await opt.optimize(SLOW, { maxIterations: 4, generationNumber: 2, signal: controller.signal });
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(result.history.length >= 2);
  assert.ok(result.best);
});

test('if the top candidates fail the held-out tests, lower-ranked correct ones are verified too', { skip: noPy, timeout: 180_000 }, async () => {
  // Very fast, but wrong for [10, 20, 30, 40] — an input that lands in the PRIVATE split.
  const TRICKY = `def has_duplicate(numbers):
    if numbers[:1] == [10]:
        return True
    return len(set(numbers)) != len(numbers)`;
  const llm = new ScriptedLLM(INPUTS, [goCot(TRICKY), goCot(FAST)]);
  const opt = new EvolutionaryOptimizer(llm, { scriptsDir: SCRIPTS_DIR, language: 'python' });
  const logs: string[] = [];
  const result = await opt.optimize(SLOW, { maxIterations: 1, generationNumber: 2, topK: 1, onProgress: (m) => logs.push(m) });
  const tricky = result.finalists.find((f) => f.code === TRICKY);
  assert.ok(tricky && tricky.acc < 1, 'the tricky candidate is caught by the held-out tests');
  assert.ok(logs.some((l) => /failed the held-out tests/.test(l)), 'the failure reason is logged');
  assert.equal(result.best?.code, FAST, 'the slower but correct candidate is still found');
  assert.ok(result.improved);
});
