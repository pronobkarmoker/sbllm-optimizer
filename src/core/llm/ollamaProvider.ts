import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { GenerateOptions, LLMProvider, LLMResponse, Prompt } from './llmProvider.js';

export interface OllamaProviderOptions {
  model: string;
  host?: string;
  /** How long to wait for a full generation. Local models on modest hardware routinely take minutes,
   *  so this is deliberately generous; the caller's AbortSignal is the real cancel path. */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * Talks to Ollama over node:http rather than global fetch, deliberately.
 *
 * Node 18's fetch (undici) imposes its own headers timeout and aborts a request with the opaque
 * `UND_ERR_HEADERS_TIMEOUT` when a slow local model hasn't produced response headers yet — which is
 * a normal state for a cold model, not an error. Worse, inside the VS Code extension host the same
 * call surfaced only as "fetch failed" with no cause, because VS Code patches networking there for
 * proxy support. node:http avoids both: timeouts are ours to set, and errors arrive with real codes.
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaProviderOptions) {
    this.host = opts.host ?? 'http://127.0.0.1:11434';
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    const messages = [
      ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
      { role: 'user', content: prompt.user },
    ];

    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: false,
      options: { temperature: opts.temperature ?? 0.7 },
    });

    const raw = await this.post('/api/chat', body, opts.signal);
    let data: OllamaChatResponse;
    try {
      data = JSON.parse(raw) as OllamaChatResponse;
    } catch {
      throw new Error(`Ollama returned a non-JSON response: ${raw.slice(0, 200)}`);
    }
    if (data.error) throw new Error(`Ollama error: ${data.error}`);

    return { text: data.message?.content ?? '', raw: data };
  }

  private post(pathname: string, body: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(pathname, this.host);
      } catch {
        return reject(new Error(`sbllmOptimizer.ollamaHost is not a valid URL: "${this.host}"`));
      }

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (out += chunk));
          res.on('end', () => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`Ollama request failed: ${res.statusCode} ${res.statusMessage} — ${out.slice(0, 300)}`));
            } else {
              resolve(out);
            }
          });
        },
      );

      const onAbort = () => {
        req.destroy();
        const err = new Error('Generation cancelled');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(
          new Error(
            `Ollama did not respond within ${Math.round(this.timeoutMs / 1000)}s. ` +
              'A large model on modest hardware can exceed this — try a smaller model, or raise the timeout.',
          ),
        );
      });

      req.on('error', (err) => {
        if ((err as Error).name === 'AbortError') return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
          reject(
            new Error(
              `Could not reach Ollama at ${this.host} (${code}). ` +
                'Check that Ollama is running ("ollama serve") and that sbllmOptimizer.ollamaHost points at it.',
            ),
          );
        } else {
          reject(err);
        }
      });

      req.end(body);
    });
  }
}
