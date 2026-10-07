import * as vscode from 'vscode';
import type { LLMProvider } from '../core/llm/llmProvider.js';
import { GeminiProvider } from '../core/llm/geminiProvider.js';
import { OllamaProvider } from '../core/llm/ollamaProvider.js';
import { OpenAIProvider } from '../core/llm/openaiProvider.js';

export const GEMINI_SECRET_KEY = 'sbllmOptimizer.geminiApiKey';
export const OPENAI_SECRET_KEY = 'sbllmOptimizer.openaiApiKey';

/** Builds the configured provider from VS Code settings + SecretStorage — API keys never touch
 *  plaintext settings.json. */
export async function buildProvider(context: vscode.ExtensionContext): Promise<{ provider: LLMProvider; label: string }> {
  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const which = cfg.get<string>('llmProvider', 'ollama');

  if (which === 'gemini') {
    const apiKey = await context.secrets.get(GEMINI_SECRET_KEY);
    if (!apiKey) throw new Error('No Gemini API key set. Run "SBLLM: Set Gemini API Key" first.');
    const model = cfg.get<string>('geminiModel') || undefined;
    return { provider: new GeminiProvider({ apiKey, model }), label: `Gemini (${model ?? 'default'})` };
  }

  if (which === 'openai') {
    const apiKey = (await context.secrets.get(OPENAI_SECRET_KEY)) ?? '';
    const baseUrl = cfg.get<string>('openaiBaseUrl', '').trim();
    if (!apiKey && !baseUrl) throw new Error('No OpenAI API key set. Run "SBLLM: Set OpenAI API Key" first.');
    const model = cfg.get<string>('openaiModel', 'gpt-5-mini');
    return { provider: new OpenAIProvider({ apiKey, model, baseUrl: baseUrl || undefined }), label: `OpenAI-compatible (${model})` };
  }

  const model = cfg.get<string>('ollamaModel', 'qwen2.5-coder:1.5b');
  return {
    provider: new OllamaProvider({ model, host: cfg.get<string>('ollamaHost') }),
    label: `Ollama (${model})`,
  };
}
