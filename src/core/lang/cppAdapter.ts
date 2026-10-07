import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallResult, LanguageAdapter, PreparedContext, RunBatchResult } from './languageAdapter.js';
import { buildHarness, serializeArgs, parseCppSignature } from './cpp/harness.js';
import { findCppFunctions, stripMainFunction } from './cpp/cppSource.js';
import { runProcess } from '../util/process.js';

export function defaultCxx(): string {
  return process.env.CXX ?? 'g++';
}

const CPP_KEYWORDS = new Set([
  'int', 'long', 'short', 'char', 'bool', 'float', 'double', 'void', 'unsigned', 'signed', 'const', 'static',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'struct', 'class',
  'public', 'private', 'protected', 'template', 'typename', 'namespace', 'using', 'new', 'delete', 'this',
  'true', 'false', 'nullptr', 'sizeof', 'auto', 'std', 'vector', 'string', 'map', 'set', 'pair', 'size_t',
  'push_back', 'emplace_back', 'begin', 'end', 'sort', 'max', 'min', 'swap', 'cout', 'cin', 'endl',
  'include', 'define', 'unordered_map', 'unordered_set', 'deque', 'queue', 'stack', 'priority_queue',
  'find', 'count', 'insert', 'erase', 'reserve', 'size', 'empty', 'substr', 'accumulate', 'lower_bound',
  'upper_bound', 'unique', 'reverse', 'memset', 'fill', 'abs', 'sqrt', 'pow', 'array', 'bitset',
]);

/** Regex-based abstraction mirroring abstract.py: identifiers and literals are normalized so
 *  structurally identical candidates dedupe to the same key (Algorithm 1). The reference
 *  implementation uses tree-sitter here, which would mean shipping a native grammar; for dedup,
 *  edit distance and BM25 retrieval the normalized token stream behaves equivalently. Line
 *  structure is preserved because pattern retrieval diffs abstracted code line by line. */
export function abstractCpp(code: string): string {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '"STR"')
    .replace(/'(?:\\.|[^'\\\n])'/g, "'STR'")
    .replace(/\b\d[\d']*(\.\d+)?([eE][+-]?\d+)?[uUlLfF]*\b/g, 'NUM');
  const normalized = stripped.replace(/[A-Za-z_]\w*/g, (m) => (CPP_KEYWORDS.has(m) || m === 'NUM' || m === 'STR' ? m : 'VAR'));
  return normalized
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * C++ counterpart to PythonAdapter. The paper evaluates on both Python and C++ (986 and 994 test
 * samples, GCC 9.4.0 with -std=c++17 -O3).
 *
 * Candidate and baseline are compiled into ONE binary, each in its own namespace, so the
 * paired-baseline timing works exactly as it does for Python: both functions are timed in the same
 * process, moments apart, so drift cancels out of the ratio instead of biasing it.
 */
export class CppAdapter implements LanguageAdapter {
  readonly id = 'cpp' as const;
  private readonly cxx: string;

  constructor(opts: { compiler?: string } = {}) {
    this.cxx = opts.compiler?.trim() || defaultCxx();
  }

  async abstract(code: string): Promise<string | null> {
    return abstractCpp(code);
  }

  async abstractMany(codes: string[]): Promise<(string | null)[]> {
    return codes.map(abstractCpp);
  }

  extractFunctionName(code: string): string | null {
    return findCppFunctions(code).find((f) => f.name !== 'main')?.name ?? null;
  }

  extractParamNames(code: string, funcName?: string): string[] | null {
    const fn = findCppFunctions(code)
      .filter((f) => f.name !== 'main')
      .filter((f) => !funcName || f.name === funcName)
      .pop();
    if (!fn) return null;
    const raw = fn.paramsText.trim();
    if (raw === '' || raw === 'void') return [];
    const res = parseCppSignature(code, fn.name);
    if (res.ok) return res.sig.params.map((p) => p.name);
    // Unsupported types still have a countable parameter list.
    return raw.split(',').map((p) => p.trim().match(/([A-Za-z_]\w*)\s*(=.*)?$/)?.[1] ?? p.trim());
  }

  async prepareContext(prefix: string): Promise<PreparedContext> {
    const { code, removed } = stripMainFunction(prefix);
    return { code, skipped: removed ? ['main() — driver code, not something the function depends on'] : [] };
  }

  /** Checks that `slowCode` can be driven by the harness, so unsupported signatures fail fast with
   *  a clear reason instead of as a confusing compile error deep inside the search. */
  checkSupported(code: string, funcName: string): string | null {
    const res = parseCppSignature(code, funcName);
    return res.ok ? null : res.reason;
  }

  async runBatch(
    code: string,
    funcName: string,
    inputs: unknown[][],
    timeoutMs = 60_000,
    baselineCode?: string,
  ): Promise<RunBatchResult> {
    const parsed = parseCppSignature(code, funcName);
    if (!parsed.ok) {
      return {
        compileError:
          `Unsupported C++ signature: ${parsed.reason}. Supported parameter and return types are ` +
          'integers, floating point, bool, char, std::string, and std::vector of those (up to one level of nesting).',
      };
    }
    const sig = parsed.sig;

    let dir: string;
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'sbllm-cpp-'));
    } catch (err) {
      return { compileError: `could not create a temp directory: ${(err as Error).message}` };
    }
    const src = path.join(dir, 'harness.cpp');
    const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');

    try {
      writeFileSync(src, buildHarness(sig, code, baselineCode), 'utf8');

      // -O3 and C++17 to match the paper's own compilation settings (§III-E).
      const compile = await runProcess(this.cxx, ['-std=c++17', '-O3', '-o', exe, src], '', 120_000);
      if (compile.spawnError) {
        return { compileError: `${compile.spawnError} Install a C++ compiler (g++) or set sbllmOptimizer.cppCompiler.` };
      }
      if (compile.timedOut) return { compileError: 'compilation timed out' };
      if (compile.code !== 0) return { compileError: firstCompilerError(compile.stderr, src) };

      const payload = [
        String(inputs.length),
        ...inputs.map((args) => {
          const body = serializeArgs(sig.params, args);
          return `${Buffer.byteLength(body, 'utf8')}\n${body}`;
        }),
      ].join('\n');

      const exec = await runProcess(exe, [], payload, timeoutMs);
      if (exec.spawnError) return { compileError: exec.spawnError };
      const results = parseResults(exec.stdout, inputs.length);
      if (exec.timedOut && (!results || results.length < inputs.length)) {
        return {
          compileError: `timed out after ${Math.round(timeoutMs / 1000)}s — the code is far too slow on these inputs, or never terminates`,
        };
      }
      if (!results) {
        return { compileError: `the program ${describeCrash(exec.code)} before reporting results` };
      }
      // A crash part-way through (e.g. a segfault on one input) leaves the remaining inputs without
      // results; report those as failures rather than silently shortening the batch.
      while (results.length < inputs.length) {
        results.push({ ok: false, error: describeCrash(exec.code), timeMs: 0 });
      }
      return { results };
    } catch (err) {
      return { compileError: (err as Error).message };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing an optimization over */
      }
    }
  }
}

/** Human-readable form of a crashed harness's exit code (Windows NTSTATUS or POSIX signal). */
export function describeCrash(code: number | null): string {
  switch (code) {
    case 3221225477: // 0xC0000005
    case 139:
    case -11:
      return 'crashed with a segmentation fault (invalid memory access, e.g. an out-of-bounds index)';
    case 3221225725: // 0xC00000FD
      return 'crashed with a stack overflow (likely unbounded recursion)';
    case 3221225620: // 0xC0000094
    case 136:
      return 'crashed with a division by zero';
    case 3:
    case 134:
      return 'aborted (std::terminate / assertion failure)';
    default:
      return `crashed (exit code ${code})`;
  }
}

function firstCompilerError(stderr: string, srcPath: string): string {
  const line = stderr.split('\n').find((l) => /\berror\b/i.test(l));
  return (line ?? stderr.split('\n')[0] ?? 'compilation failed')
    .replace(srcPath, 'harness.cpp')
    .trim()
    .slice(0, 400);
}

/** Single pass, so an escaped backslash followed by `n` is not mistaken for a newline. */
export function unescapeLine(s: string): string {
  return s.replace(/\\(\\|n)/g, (_m, c: string) => (c === 'n' ? '\n' : '\\'));
}

const STDOUT_SEP = ' |STDOUT| ';
const ARGS_SEP = ' |ARGS| ';

export function parseResults(stdout: string, expected: number): CallResult[] | null {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => l.startsWith('COMPILE_OK'));
  if (start === -1) return null;

  const results: CallResult[] = [];
  for (let i = start + 1; i < lines.length && results.length < expected; i++) {
    const line = lines[i];
    if (line.startsWith('OK ')) {
      const rest = line.slice(3);
      const sp1 = rest.indexOf(' ');
      const sp2 = rest.indexOf(' ', sp1 + 1);
      const timeMs = Number(rest.slice(0, sp1));
      const baselineMs = Number(rest.slice(sp1 + 1, sp2));
      let tail = rest.slice(sp2 + 1);
      let argsText = 'null';
      const argsAt = tail.lastIndexOf(ARGS_SEP);
      if (argsAt !== -1) {
        argsText = tail.slice(argsAt + ARGS_SEP.length);
        tail = tail.slice(0, argsAt);
      }
      const sep = tail.indexOf(STDOUT_SEP);
      const output = sep === -1 ? tail : tail.slice(0, sep);
      const stdoutText = sep === -1 ? '' : tail.slice(sep + STDOUT_SEP.length);
      const entry: CallResult = {
        ok: true,
        output: parseEmitted(unescapeLine(output)),
        stdout: unescapeLine(stdoutText),
        argsAfter: parseEmitted(unescapeLine(argsText)),
        timeMs: Number.isFinite(timeMs) ? timeMs : 0,
      };
      if (Number.isFinite(baselineMs) && baselineMs >= 0) entry.baselineTimeMs = baselineMs;
      results.push(entry);
    } else if (line.startsWith('ERR ')) {
      results.push({ ok: false, error: unescapeLine(line.slice(4)), timeMs: 0 });
    }
  }
  return results;
}

/** Turns the harness's emitted value back into a JS value so deepAlmostEqual can compare it. */
function parseEmitted(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
