export interface Prompt {
  system?: string;
  user: string;
}

export interface LLMResponse {
  text: string;
  raw?: unknown;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  temperature?: number;
  onToken?: (token: string) => void;
}

export interface LLMProvider {
  readonly id: string;
  generate(prompt: Prompt, opts?: GenerateOptions): Promise<LLMResponse>;
}
