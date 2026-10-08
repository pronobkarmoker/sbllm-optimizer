import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { DegenerateOutputError, isDegenerateRepetition, type GenerateOptions, type LLMProvider, type LLMResponse, type Prompt } from './llmProvider.js';

/** Enough for a full GO-COT answer (reasoning + a complete function); stops runaway generations. */
const DEFAULT_MAX_TOKENS = 2048;
/** Ollama's own default window is small (and it silently cuts longer prompts to fit). 8192 fits a
 *  1.5B model in ~1.3 GB; 32k ran out of memory on an 8 GB laptop. */
const DEFAULT_CONTEXT_WINDOW = 8192;

export interface OllamaProviderOptions {
  model: string;
  host?: string;
  /** Idle timeout between streamed chunks — not a cap on total generation time. Streaming makes a
   *  long generation look like steady activity rather than one long silence. */
  idleTimeoutMs?: number;
  /** Context window (num_ctx) requested from Ollama for every call. */
  contextWindow?: number;
}

/**
 * Talks to Ollama with `stream: true` and accumulates the NDJSON chunks.
 *
 * Streaming is the important part, and it fixes two failures seen in this project:
 *
 *  1. Non-streaming requests made Node 18's fetch abort a slow-but-healthy local model with
 *     `UND_ERR_HEADERS_TIMEOUT`, because no response headers arrive until generation finishes.
 *     Streaming sends headers immediately, so there is no long silence to time out on.
 *  2. A non-streaming `node:http` request inside the VS Code extension host returned HTTP 200 with
 *     a real `content-length` (518 bytes) while delivering nothing to `res.on('data')` — the body
 *     was never readable there. Reading a stream incrementally avoids depending on that.
 *
 * Both transports are attempted: fetch first (it is what worked historically in the extension
 * host), then node:http. A transport that yields no content is treated as a failure and the other
 * is tried, rather than surfacing an empty completion as if the model had said nothing.
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly contextWindow: number;
  readonly maxOutputTokens = DEFAULT_MAX_TOKENS;
  private readonly host: string;
  private readonly model: string;
  private readonly idleTimeoutMs: number;

  constructor(opts: OllamaProviderOptions) {
    this.host = opts.host ?? 'http://127.0.0.1:11434';
    this.model = opts.model;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.contextWindow = opts.contextWindow && opts.contextWindow >= 2048 ? opts.contextWindow : DEFAULT_CONTEXT_WINDOW;
  }

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
        { role: 'user', content: prompt.user },
      ],
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // Always explicit: a constant value also keeps Ollama from reloading the model between calls.
        num_ctx: this.contextWindow,
        // Discourages the repetition loops small models fall into; mild enough not to hurt code,
        // which legitimately repeats tokens.
        repeat_penalty: 1.1,
        repeat_last_n: 256,
      },
    });

    const failures: string[] = [];

    for (const transport of ['fetch', 'http'] as const) {
      try {
        const text =
          transport === 'fetch'
            ? await this.viaFetch(body, opts)
            : await this.viaNodeHttp(body, opts);
        if (text.trim() !== '') return { text };
        failures.push(`${transport}: connected but returned no content`);
      } catch (err) {
        if ((err as Error).name === 'AbortError' || err instanceof DegenerateOutputError) throw err;
        failures.push(`${transport}: ${(err as Error).message}`);
      }
    }

    throw new Error(
      `Could not get a response from Ollama at ${this.host}. Tried both transports — ${failures.join(' | ')}. ` +
        'Check that Ollama is running ("ollama serve") and that sbllmOptimizer.ollamaHost is correct.',
    );
  }

  /** Consumes one NDJSON line, returning any content it carries. Ollama reports errors in-band. */
  private consumeLine(line: string, out: { text: string; checkedAt?: number }): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let obj: { message?: { content?: string }; error?: string };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // a partial line; the caller buffers and retries
    }
    if (obj.error) throw new Error(`Ollama error: ${obj.error}`);
    if (obj.message?.content) out.text += obj.message.content;
    // Checked every ~400 new characters while streaming, so a looping reply is cut off within
    // seconds instead of running to the token cap (minutes, on a CPU-only local model).
    if (out.text.length - (out.checkedAt ?? 0) >= 400) {
      out.checkedAt = out.text.length;
      if (isDegenerateRepetition(out.text)) throw new DegenerateOutputError();
    }
  }

  private async viaFetch(body: string, opts: GenerateOptions): Promise<string> {
    const res = await fetch(new URL('/api/chat', this.host).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body,
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('response had no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const out = { text: '' };
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) this.consumeLine(line, out);
      }
      this.consumeLine(buffer, out);
    } catch (err) {
      // Stop the server-side generation too, not just our reading of it.
      await reader.cancel().catch(() => {});
      throw err;
    }
    return out.text;
  }

  private viaNodeHttp(body: string, opts: GenerateOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL('/api/chat', this.host);
      } catch {
        return reject(new Error(`sbllmOptimizer.ollamaHost is not a valid URL: "${this.host}"`));
      }

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'application/x-ndjson',
          },
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
          }
          const out = { text: '' };
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            try {
              for (const line of lines) this.consumeLine(line, out);
            } catch (e) {
              req.destroy();
              reject(e as Error);
            }
          });
          res.on('end', () => {
            try {
              this.consumeLine(buffer, out);
            } catch (e) {
              return reject(e as Error);
            }
            resolve(out.text);
          });
          res.on('error', reject);
        },
      );

      const onAbort = () => {
        req.destroy();
        const err = new Error('Generation cancelled');
        err.name = 'AbortError';
        reject(err);
      };
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Idle timeout, not a total-time cap: streaming means chunks arrive steadily, so a genuine
      // stall is distinguishable from a long generation.
      req.setTimeout(this.idleTimeoutMs, () =>
        req.destroy(new Error(`no data from Ollama for ${Math.round(this.idleTimeoutMs / 1000)}s`)),
      );

      req.on('error', (err) => {
        if ((err as Error).name === 'AbortError') return;
        const code = (err as NodeJS.ErrnoException).code;
        reject(new Error(code ? `${code} ${err.message}` : err.message));
      });

      req.end(body);
    });
  }
}
