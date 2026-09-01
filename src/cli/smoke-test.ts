import 'dotenv/config';
import type { LLMProvider } from '../core/llm/llmProvider.js';
import { GeminiProvider } from '../core/llm/geminiProvider.js';
import { OllamaProvider } from '../core/llm/ollamaProvider.js';

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
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
    host: process.env.OLLAMA_HOST,
  });
}

async function main() {
  const provider = buildProvider();

  console.log(`[smoke-test] calling ${provider.id}...`);
  const response = await provider.generate({
    system: 'You are a terse assistant. Reply in one short sentence.',
    user: 'Say hello and confirm you can see this working end to end.',
  });

  console.log('[smoke-test] response:');
  console.log(response.text);
}

main().catch((err) => {
  console.error('[smoke-test] failed:', err);
  process.exit(1);
});
