import path from 'node:path';
import type { LanguageAdapter, PreparedContext, RunBatchResult, RunOptions } from './languageAdapter.js';
import { runProcess } from '../util/process.js';

export type { CallResult, RunBatchResult } from './languageAdapter.js';

const RESULT_MARKER = '__SBLLM_RESULT__';

export function defaultPythonBin(): string {
  return process.env.PYTHON_BIN ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * Python implementation of LanguageAdapter. `scriptsDir` (the directory containing abstract.py /
 * run_candidate.py / analyze.py) is passed in explicitly rather than derived from
 * `import.meta.url`, so this class has no opinion about how it's packaged: the CLI resolves the path
 * from its own module location, while the bundled VS Code extension resolves it from
 * `context.extensionPath` after esbuild has bundled everything into one file.
 */
export class PythonAdapter implements LanguageAdapter {
  readonly id = 'python' as const;
  private readonly pythonBin: string;

  constructor(
    private readonly scriptsDir: string,
    opts: { pythonPath?: string } = {},
  ) {
    this.pythonBin = opts.pythonPath?.trim() || defaultPythonBin();
  }

  async abstract(code: string): Promise<string | null> {
    const [one] = await this.abstractMany([code]);
    return one ?? null;
  }

  async abstractMany(codes: string[]): Promise<(string | null)[]> {
    if (codes.length === 0) return [];
    const res = await this.runJsonScript('abstract.py', JSON.stringify({ codes }), 30_000);
    if (!res || !Array.isArray(res.abstracted)) return codes.map(() => null);
    return codes.map((_, i) => (typeof res.abstracted[i] === 'string' ? res.abstracted[i] : null));
  }

  async prepareContext(prefix: string): Promise<PreparedContext> {
    if (!prefix.trim()) return { code: '', skipped: [] };
    const res = await this.runJsonScript('analyze.py', JSON.stringify({ mode: 'context', code: prefix }), 15_000);
    if (!res || typeof res.code !== 'string') return { code: prefix, skipped: [] };
    const skipped = Array.isArray(res.skipped)
      ? res.skipped.map((s: { line: number; text: string }) => `line ${s.line}: ${s.text}`)
      : [];
    return { code: res.code, skipped };
  }

  /** Adds imports for well-known stdlib names `code` uses without importing (analyze.py "repair"
   *  mode — parsing only, nothing is executed). */
  async repairImports(code: string, context: string): Promise<{ code: string; added: string[]; removed: number }> {
    const res = await this.runJsonScript('analyze.py', JSON.stringify({ mode: 'repair', code, context }), 15_000);
    if (!res || typeof res.code !== 'string') return { code, added: [], removed: 0 };
    return {
      code: res.code,
      added: Array.isArray(res.added) ? res.added : [],
      removed: typeof res.removed === 'number' ? res.removed : 0,
    };
  }

  async sliceContext(context: string, target: string): Promise<{ code: string; kept: number; total: number }> {
    if (!context.trim()) return { code: '', kept: 0, total: 0 };
    const res = await this.runJsonScript('analyze.py', JSON.stringify({ mode: 'slice', code: context, target }), 15_000);
    if (!res || res.ok === false || typeof res.code !== 'string') return { code: context, kept: 0, total: 0 };
    return { code: res.code, kept: res.kept ?? 0, total: res.total ?? 0 };
  }

  /** Single-mutation variants of `funcName` (analyze.py "mutants" mode) for mutation analysis. */
  async mutants(code: string, funcName: string, limit: number): Promise<{ description: string; code: string }[]> {
    const res = await this.runJsonScript('analyze.py', JSON.stringify({ mode: 'mutants', code, funcName, limit }), 15_000);
    return res && Array.isArray(res.mutants) ? res.mutants : [];
  }

  /** Static analysis (analyze.py "analyze" mode). Parsing only — no user code is executed. */
  async analyze(code: string): Promise<unknown> {
    return this.runJsonScript('analyze.py', JSON.stringify({ mode: 'analyze', code }), 15_000);
  }

  async runBatch(
    code: string,
    funcName: string,
    inputs: unknown[][],
    timeoutMs = 20_000,
    baselineCode?: string,
    options: RunOptions = {},
  ): Promise<RunBatchResult> {
    const proc = await runProcess(
      this.pythonBin,
      [path.join(this.scriptsDir, 'run_candidate.py')],
      JSON.stringify({ code, funcName, inputs, baselineCode, timing: options.timing !== false }),
      timeoutMs,
      this.env(),
    );
    if (proc.spawnError) return { compileError: proc.spawnError };
    if (proc.timedOut) {
      return {
        compileError: `timed out after ${Math.round(timeoutMs / 1000)}s — the code is far too slow on these inputs, or never terminates`,
      };
    }
    const parsed = parseMarkedResult(proc.stdout);
    if (!parsed) {
      const tail = proc.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
      return { compileError: `the Python process exited (code ${proc.code}) without reporting results${tail ? `: ${tail}` : ''}` };
    }
    return parsed as RunBatchResult;
  }

  extractFunctionName(code: string): string | null {
    // Prefer a top-level def; fall back to any def.
    const top = code.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/m);
    if (top) return top[1];
    const any = code.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/m);
    return any ? any[1] : null;
  }

  extractParamNames(code: string, funcName?: string): string[] | null {
    return parsePythonParams(code, funcName ?? this.extractFunctionName(code) ?? undefined);
  }

  private env(): NodeJS.ProcessEnv {
    // Fixed hash seed: set/dict-of-str iteration order must be identical between the process that
    // captured ground truth and the one evaluating a candidate. UTF-8 so non-ASCII output survives
    // the Windows console code page.
    return { ...process.env, PYTHONHASHSEED: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  }

  private async runJsonScript(scriptName: string, stdin: string, timeoutMs: number): Promise<any> {
    const proc = await runProcess(this.pythonBin, [path.join(this.scriptsDir, scriptName)], stdin, timeoutMs, this.env());
    if (proc.spawnError) throw new Error(proc.spawnError);
    const lastLine = proc.stdout.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(lastLine);
    } catch {
      return null;
    }
  }
}

function parseMarkedResult(stdout: string): unknown | null {
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  if (idx === -1) return null;
  const line = stdout.slice(idx + RESULT_MARKER.length).split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Parameter names of `def funcName(...)`, parsed with bracket and string awareness. The previous
 * single-regex parser split `d: dict[str, int]` into two parameters and stopped at the first `)` in
 * a default value, so a candidate that merely kept a type hint was rejected as having "changed the
 * signature". Bare `*` and `/` markers are not parameters and are dropped; `*args`/`**kwargs` keep
 * their stars so they stay distinguishable from plain positional names.
 */
export function parsePythonParams(code: string, funcName?: string): string[] | null {
  const re = funcName
    ? new RegExp(`(^|\\n)[ \\t]*(?:async\\s+)?def\\s+${escapeRegExp(funcName)}\\s*\\(`)
    : /(^|\n)[ \t]*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;
  const m = re.exec(code);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  const pieces: string[] = [];
  for (; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += code[++i] ?? '';
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '#') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    }
    if (c === ',' && depth === 0) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) pieces.push(current);

  return pieces
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '*' && p !== '/')
    .map((p) => {
      const star = p.startsWith('**') ? '**' : p.startsWith('*') ? '*' : '';
      const name = p.slice(star.length).split(/[:=]/)[0].trim();
      return star + name;
    })
    .filter((p) => /^\*{0,2}[A-Za-z_]\w*$/.test(p));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
