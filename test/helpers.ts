import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GenerateOptions, LLMProvider, LLMResponse, Prompt } from '../src/core/llm/llmProvider.js';
import { defaultPythonBin } from '../src/core/lang/pythonAdapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.join(here, '..', 'src', 'core', 'lang', 'python');

function available(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export const HAS_PYTHON = available(defaultPythonBin(), ['--version']);
export const HAS_GXX = available(process.env.CXX ?? 'g++', ['--version']);

/**
 * Deterministic stand-in for an LLM: answers the test-input prompt with fixed inputs and every
 * optimization prompt with the next scripted response (cycling). Records every prompt it saw.
 */
export class ScriptedLLM implements LLMProvider {
  readonly id = 'scripted';
  readonly prompts: Prompt[] = [];
  private next = 0;

  constructor(
    private readonly inputsJson: string,
    private readonly responses: string[],
    private readonly onCall?: (n: number) => void,
  ) {}

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    if (opts.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    this.prompts.push(prompt);
    if (prompt.system?.includes('generate test inputs')) return { text: this.inputsJson };
    const text = this.responses[this.next % this.responses.length];
    this.next++;
    this.onCall?.(this.next);
    return { text };
  }
}

export function goCot(code: string, explanation = 'explanation'): string {
  return JSON.stringify({ analysis: 'analysis', opportunities: 'opportunities', explanation, code });
}
