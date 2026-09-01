import * as vscode from 'vscode';
import type { LLMProvider } from '../core/llm/llmProvider.js';
import { GeminiProvider } from '../core/llm/geminiProvider.js';
import { OllamaProvider } from '../core/llm/ollamaProvider.js';

export const GEMINI_SECRET_KEY = 'sbllmOptimizer.geminiApiKey';

/** Builds the configured provider from VS Code settings + SecretStorage — API keys never touch
 *  plaintext settings.json, per ARCHITECTURE.md §6. */
export async function buildProvider(context: vscode.ExtensionContext): Promise<LLMProvider> {
  const cfg = vscode.workspace.getConfiguration('sbllmOptimizer');
  const which = cfg.get<string>('llmProvider', 'ollama');

  if (which === 'gemini') {
    const apiKey = await context.secrets.get(GEMINI_SECRET_KEY);
    if (!apiKey) {
      throw new Error('No Gemini API key set. Run "SBLLM: Set Gemini API Key" first.');
    }
    return new GeminiProvider({ apiKey, model: cfg.get<string>('geminiModel') });
  }

  return new OllamaProvider({
    model: cfg.get<string>('ollamaModel', 'qwen2.5-coder:1.5b'),
    host: cfg.get<string>('ollamaHost'),
  });
}
