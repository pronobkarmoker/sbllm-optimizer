import 'dotenv/config';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCliProvider } from './provider.js';
import { EvolutionaryOptimizer } from '../core/optimizer/evolutionaryOptimizer.js';
import { split } from './splitFunction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'core', 'lang', 'python');

const EXAMPLE_SLOW_CODE = `def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False
`;

/**
 * Usage: npm run optimize -- [file.py|file.cpp] [functionName]
 *
 * With a file, the named function (or the last function in the file) is optimized, and everything
 * above it is used as file context — the same thing the extension does.
 */
async function main() {
  const { provider, label } = buildCliProvider();
  const fileArg = process.argv[2];
  const fnArg = process.argv[3];
  const language = fileArg && /\.(cpp|cc|cxx|hpp|h)$/i.test(fileArg) ? ('cpp' as const) : ('python' as const);
  const optimizer = new EvolutionaryOptimizer(provider, {
    scriptsDir: SCRIPTS_DIR,
    language,
    pythonPath: process.env.PYTHON_BIN,
    cppCompiler: process.env.CXX,
    patternFile: process.env.SBLLM_PATTERN_FILE,
  });

  let slowCode = EXAMPLE_SLOW_CODE;
  let contextPrefix = '';
  if (fileArg) {
    const text = readFileSync(fileArg, 'utf8').replace(/\r\n/g, '\n');
    const parts = split(text, language, fnArg);
    if (!parts) throw new Error(`No function${fnArg ? ` named ${fnArg}` : ''} found in ${fileArg}`);
    slowCode = parts.code;
    contextPrefix = parts.prefix;
  }

  console.log(`Provider: ${label} | language: ${language}`);
  if (fileArg) console.log(`Source: ${fileArg}`);
  console.log('Slow code:\n' + slowCode);

  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('\n[optimizer] cancelling — reporting the best result so far…');
    controller.abort();
  });

  const result = await optimizer.optimize(slowCode, {
    contextPrefix,
    signal: controller.signal,
    onProgress: (msg) => console.log('[optimizer] ' + msg),
  });

  console.log('\n=== Result (verified on held-out private test cases) ===');
  if (result.best) {
    console.log(`Improved: ${result.improved} (threshold ${result.minSpeedup}x)`);
    console.log(
      `Speedup: ${result.best.speedup.toFixed(2)}x  (original ${fmt(result.best.baselineTimeMs)} -> optimized ${fmt(result.best.avgTimeMs)} per call)`,
    );
    console.log('\nBest optimized code:\n' + result.best.code);
  } else {
    console.log('No candidate was correct on both public and private tests.');
  }

  console.log('\n=== Finalists (private-test verification) ===');
  for (const f of result.finalists) {
    console.log(
      `#${f.id}: public ${f.publicSpeedup.toFixed(2)}x -> private acc=${f.acc.toFixed(2)} speedup=${f.speedup.toFixed(2)}x` +
        (f.error ? ` error=${f.error}` : ''),
    );
  }

  console.log('\n=== Search trace ===');
  for (const it of result.iterations) {
    console.log(
      `iter ${it.iteration}: RS={${it.representativeIds.map((i) => '#' + i).join(',')}} ` +
        `similar=${it.similarPattern ?? '-'} different=${it.differentPattern ?? '-'} new={${it.newCandidateIds.map((i) => '#' + i).join(',')}}`,
    );
  }
  console.log('\n=== All candidates ===');
  for (const c of result.history) {
    console.log(`#${c.id} (iter ${c.iteration}): acc=${c.acc.toFixed(2)} speedup=${c.speedup.toFixed(2)}x${c.error ? ` error=${c.error}` : ''}`);
  }
}

function fmt(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1 ? `${ms.toFixed(3)} ms` : `${(ms * 1000).toFixed(2)} µs`;
}

main().catch((err) => {
  console.error('optimize failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
