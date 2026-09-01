import type { GenerateOptions, LLMProvider, LLMResponse, Prompt } from './llmProvider.js';

export interface OllamaProviderOptions {
  model: string;
  host?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  private readonly host: string;
  private readonly model: string;

  constructor(opts: OllamaProviderOptions) {
    this.host = opts.host ?? 'http://127.0.0.1:11434';
    this.model = opts.model;
  }

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    const messages = [
      ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
      { role: 'user', content: prompt.user },
    ];

    // Node reports every network-level failure as the bare string "fetch failed" and buries the
    // real reason (ECONNREFUSED, ENOTFOUND, a TLS problem) in err.cause. Surfacing just the message
    // makes the most common setup failure — Ollama not running — indistinguishable from a typo in
    // the host setting, so unwrap the cause and say what to actually do about it.
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: { temperature: opts.temperature ?? 0.7 },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ?? cause?.message ?? (err as Error)?.message ?? 'unknown';
      throw new Error(
        `Could not reach Ollama at ${this.host} (${detail}). ` +
          `Check that Ollama is running ("ollama serve") and that sbllmOptimizer.ollamaHost points at it.`,
      );
    }

    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText} — ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    return { text: data.message?.content ?? '', raw: data };
  }
}
