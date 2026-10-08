export interface Prompt {
  system?: string;
  user: string;
  /** Parts shortened or dropped to fit the context window (for the progress log). */
  trimmed?: string[];
}

export interface LLMResponse {
  text: string;
  raw?: unknown;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  temperature?: number;
  /** Upper bound on generated tokens. Small local models occasionally fall into a repetition loop and
   *  would otherwise stream forever (observed: 9,000+ tokens for a reply that should be ~300). */
  maxTokens?: number;
  onToken?: (token: string) => void;
}

export interface LLMProvider {
  readonly id: string;
  /** Total tokens (prompt + reply) the model can handle in one call, when known. */
  readonly contextWindow?: number;
  /** Tokens reserved for the reply. */
  readonly maxOutputTokens?: number;
  generate(prompt: Prompt, opts?: GenerateOptions): Promise<LLMResponse>;
}

/** The model fell into a repetition loop (the same text over and over) instead of answering. It is
 *  an unusable sample, not a connectivity failure — callers skip it and move on. */
export class DegenerateOutputError extends Error {
  constructor(message = 'the model got stuck repeating itself') {
    super(message);
    this.name = 'DegenerateOutputError';
  }
}

/**
 * True when the end of `text` is one chunk (30–600 chars) repeated back to back at least six times
 * — the signature of a small model stuck in a loop (observed: one sentence repeated ~100 times until
 * the token cap, with no code ever produced).
 */
export function isDegenerateRepetition(text: string, minRepeats = 6): boolean {
  for (let period = 30; period <= 600; period++) {
    const span = period * minRepeats;
    if (span > text.length) break;
    const tail = text.slice(-span);
    const unit = tail.slice(-period);
    if (unit.trim().length < 10) continue;
    if (tail === unit.repeat(minRepeats)) return true;
  }
  return false;
}
