import type { LLMProvider } from '../core/llm/llmProvider.js';
import { GeminiProvider } from '../core/llm/geminiProvider.js';
import { OllamaProvider } from '../core/llm/ollamaProvider.js';
import { OpenAIProvider } from '../core/llm/openaiProvider.js';

/** Provider for the CLI tools, configured from environment variables (see .env.example). */
export function buildCliProvider(): { provider: LLMProvider; label: string } {
  const which = process.env.LLM_PROVIDER ?? 'ollama';

  if (which === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not set. Copy .env.example to .env and fill it in.');
      process.exit(1);
    }
    const model = process.env.GEMINI_MODEL || undefined;
    return { provider: new GeminiProvider({ apiKey, model }), label: `gemini (${model ?? 'default'})` };
  }

  if (which === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const baseUrl = process.env.OPENAI_BASE_URL || undefined;
    if (!apiKey && !baseUrl) {
      console.error('OPENAI_API_KEY not set. Copy .env.example to .env and fill it in.');
      process.exit(1);
    }
    const model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
    return { provider: new OpenAIProvider({ apiKey, model, baseUrl }), label: `openai (${model})` };
  }

  const model = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:1.5b';
  const contextWindow = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
  return { provider: new OllamaProvider({ model, host: process.env.OLLAMA_HOST, contextWindow }), label: `ollama (${model})` };
}
