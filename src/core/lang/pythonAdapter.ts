import { spawn } from 'node:child_process';
import path from 'node:path';
import type { LanguageAdapter } from './languageAdapter.js';

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python';

export interface CallResult {
  ok: boolean;
  output?: unknown;
  /** Captured stdout from the call — part of a function's observable behavior, since some
   *  functions communicate only via print() and never return anything meaningful. */
  stdout?: string;
  error?: string;
  timeMs: number;
  /** Present when a baselineCode was supplied to runBatch — the original function re-timed in the
   *  SAME subprocess invocation, immediately alongside this call, so both experience identical
   *  system conditions and the ratio between them isn't exposed to drift over the course of a
   *  search session. */
  baselineTimeMs?: number;
}

export interface RunBatchResult {
  compileError?: string;
  results?: CallResult[];
}

/**
 * Phase 0 stand-in for the full LanguageAdapter interface — Python only, no VS Code TextDocument
 * dependency. `scriptsDir` (the directory containing abstract.py / run_candidate.py) is passed in
 * explicitly rather than derived from `import.meta.url` — deliberately, so this class has no
 * opinion about how it's packaged: the CLI resolves the path from its own module location, while
 * the bundled VS Code extension resolves it from `context.extensionPath` after esbuild has bundled
 * everything into one file (where a `__dirname`/`import.meta.url`-based guess would silently break).
 */
export class PythonAdapter implements LanguageAdapter {
  readonly id = 'python' as const;

  constructor(private readonly scriptsDir: string) {}

  async abstract(code: string): Promise<string | null> {
    const res = await this.runScript('abstract.py', code, 10_000);
    return res.ok ? res.abstracted : null;
  }

  async runBatch(
    code: string,
    funcName: string,
    inputs: unknown[][],
    timeoutMs = 20_000,
    baselineCode?: string,
  ): Promise<RunBatchResult> {
    return this.runScript(
      'run_candidate.py',
      JSON.stringify({ code, funcName, inputs, baselineCode }),
      timeoutMs,
    );
  }

  extractFunctionName(code: string): string | null {
    const match = code.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m);
    return match ? match[1] : null;
  }

  /** Simple single-line signature parser — good enough for the plain functions this tool targets. */
  extractParamNames(code: string): string[] | null {
    const match = code.match(/^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/m);
    if (!match) return null;
    const raw = match[1].trim();
    if (raw === '') return [];
    return raw
      .split(',')
      .map((p) => p.trim().split(/[:=]/)[0].trim())
      .filter(Boolean);
  }

  private runScript(scriptName: string, stdinPayload: string, timeoutMs: number): Promise<any> {
    const scriptPath = path.join(this.scriptsDir, scriptName);

    return new Promise((resolve, reject) => {
      const child = spawn(PYTHON_BIN, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`python ${scriptName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        try {
          resolve(JSON.parse(lastLine));
        } catch {
          reject(new Error(`failed to parse python output from ${scriptName}: ${stdout}\n${stderr}`));
        }
      });

      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }
}
