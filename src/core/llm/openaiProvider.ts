import type { GenerateOptions, LLMProvider, LLMResponse, Prompt } from './llmProvider.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** Any OpenAI-compatible Chat Completions endpoint (OpenAI, Azure-compatible proxies, LM Studio,
   *  vLLM, ...). Defaults to the OpenAI API. */
  baseUrl?: string;
}

/**
 * OpenAI Chat Completions over plain fetch — no SDK dependency, so the bundle stays small and any
 * OpenAI-compatible server works by changing the base URL.
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  private readonly baseUrl: string;
  /** Some models (reasoning models) reject a custom temperature; remembered after the first 400. */
  private temperatureSupported = true;

  constructor(private readonly opts: OpenAIProviderOptions) {
    if (!opts.apiKey && !opts.baseUrl) throw new Error('OpenAIProvider: apiKey is required');
    this.baseUrl = (opts.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    const messages = [
      ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
      { role: 'user', content: prompt.user },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      const body: Record<string, unknown> = { model: this.opts.model, messages };
      if (this.temperatureSupported) body.temperature = opts.temperature ?? 0.7;

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 400 && this.temperatureSupported && /temperature/i.test(detail)) {
          this.temperatureSupported = false;
          continue;
        }
        let message = detail;
        try {
          message = JSON.parse(detail)?.error?.message ?? detail;
        } catch {
          /* not JSON */
        }
        throw new Error(`OpenAI API error ${res.status}: ${String(message).slice(0, 300)}`);
      }

      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('OpenAI API returned an empty response');
      return { text, raw: json };
    }
    throw new Error('OpenAI API request failed');
  }
}
