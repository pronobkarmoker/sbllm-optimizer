import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerateOptions, LLMProvider, LLMResponse, Prompt } from './llmProvider.js';

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  private readonly client: GoogleGenerativeAI;
  private readonly modelName: string;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) {
      throw new Error('GeminiProvider: apiKey is required');
    }
    this.client = new GoogleGenerativeAI(opts.apiKey);
    this.modelName = opts.model ?? 'gemini-3.6-flash';
  }

  async generate(prompt: Prompt, opts: GenerateOptions = {}): Promise<LLMResponse> {
    if (opts.signal?.aborted) {
      throw new DOMException('Generation cancelled before it started', 'AbortError');
    }

    const model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: prompt.system,
    });

    const result = await model.generateContent(
      {
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.7,
        },
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );

    const text = result.response.text();
    return { text, raw: result.response };
  }
}
