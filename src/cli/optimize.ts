import 'dotenv/config';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '../core/llm/llmProvider.js';
import { GeminiProvider } from '../core/llm/geminiProvider.js';
import { OllamaProvider } from '../core/llm/ollamaProvider.js';
import { EvolutionaryOptimizer } from '../core/optimizer/evolutionaryOptimizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'core', 'lang', 'python');

const EXAMPLE_SLOW_CODE = `def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False
`;

function buildProvider(): LLMProvider {
  const which = process.env.LLM_PROVIDER ?? 'ollama';

  if (which === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not set. Copy .env.example to .env and fill it in.');
      process.exit(1);
    }
    return new GeminiProvider({ apiKey });
  }

  return new OllamaProvider({
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:1.5b',
    host: process.env.OLLAMA_HOST,
  });
}

async function main() {
  const provider = buildProvider();
  const optimizer = new EvolutionaryOptimizer(provider, { scriptsDir: SCRIPTS_DIR });

  // Optional file argument: `npm run optimize -- examples/has_duplicate.py`. Falls back to the
  // built-in example so the bare `npm run optimize` still works.
  const fileArg = process.argv[2];
  const slowCode = fileArg ? readFileSync(fileArg, 'utf8') : EXAMPLE_SLOW_CODE;

  console.log(`Using provider: ${provider.id}`);
  if (fileArg) console.log(`Source: ${fileArg}`);
  console.log('Slow code:\n' + slowCode);

  const result = await optimizer.optimize(slowCode, {
    ns: 3,
    maxIterations: 4,
    onProgress: (msg) => console.log('[optimizer] ' + msg),
  });

  console.log('\n=== Result (verified on held-out private test cases) ===');
  console.log(`Correct: ${result.best.acc === 1}`);
  console.log(`Speedup: ${result.best.speedup?.toFixed(2)}x (baseline avg ${result.baselineTimeMs.toFixed(3)}ms/call)`);
  console.log('\nBest optimized code:\n' + result.best.code);

  console.log('\n=== Full history ===');
  result.history.forEach((c, i) => {
    console.log(`#${i}: acc=${c.acc?.toFixed(2)} speedup=${c.speedup?.toFixed(2)}x${c.error ? ` error=${c.error}` : ''}`);
  });
}

main().catch((err) => {
  console.error('optimize failed:', err);
  process.exit(1);
});
