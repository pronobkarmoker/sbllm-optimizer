import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallResult, RunBatchResult } from './pythonAdapter.js';
import type { LanguageAdapter } from './languageAdapter.js';
import { buildHarness, serializeArgs, isSupportedType, type CppParam, type CppSignature } from './cpp/harness.js';

const CXX = process.env.CXX ?? 'g++';

/**
 * C++ counterpart to PythonAdapter. The paper evaluates on both Python and C++ (§IV: 986 Python and
 * 994 C++ test samples, GCC 9.4.0 with -std=c++17 -O3), so this exists to cover the second half of
 * that scope rather than as a speculative extension.
 *
 * The compile-then-run step is the substantive difference from Python. Candidate and baseline are
 * compiled into ONE binary, each in its own namespace, so the paired-baseline timing works exactly
 * as it does for Python: both functions are timed in the same process, moments apart, so drift
 * cancels out of the ratio instead of biasing it.
 */
export class CppAdapter implements LanguageAdapter {
  readonly id = 'cpp' as const;

  /** Mirrors abstract.py: identifiers and literals are normalized so structurally identical
   *  candidates dedupe to the same key during representative selection (Algorithm 1). Regex-based
   *  rather than AST-based — the reference implementation uses tree-sitter here, which would mean
   *  shipping a native grammar; for dedup and edit-distance the normalized token stream behaves
   *  equivalently. */
  async abstract(code: string): Promise<string | null> {
    const KEYWORDS = new Set([
      'int','long','short','char','bool','float','double','void','unsigned','signed','const','static',
      'return','if','else','for','while','do','switch','case','break','continue','struct','class',
      'public','private','protected','template','typename','namespace','using','new','delete','this',
      'true','false','nullptr','sizeof','auto','std','vector','string','map','set','pair','size_t',
      'push_back','begin','end','sort','max','min','swap','cout','cin','endl','include','define',
    ]);
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/"(?:\\.|[^"\\])*"/g, '"STR"')
      .replace(/'(?:\\.|[^'\\])'/g, "'C'")
      .replace(/\b\d+(\.\d+)?\b/g, 'NUM');
    const normalized = stripped.replace(/[A-Za-z_]\w*/g, (m) => (KEYWORDS.has(m) ? m : 'VAR'));
    return normalized.replace(/\s+/g, ' ').trim();
  }

  extractFunctionName(code: string): string | null {
    return this.parseSignature(code)?.name ?? null;
  }

  extractParamNames(code: string): string[] | null {
    const sig = this.parseSignature(code);
    if (!sig) return null;
    return sig.params.map((p) => p.name);
  }

  /**
   * Parses the first non-main function definition. Deliberately conservative: it returns null rather
   * than guessing on anything it doesn't fully understand, because a misparsed signature would
   * produce a harness that doesn't compile — a confusing failure to surface to a user.
   */
  parseSignature(code: string): CppSignature | null {
    const cleaned = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const re =
      /(^|\n)\s*((?:const\s+)?(?:unsigned\s+|signed\s+)?(?:long\s+long|long|short|int|char|bool|float|double|void|size_t|std::string|string|std::vector\s*<[^>]*>|vector\s*<[^>]*>)\s*[&*]?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const name = m[3];
      if (name === 'main') continue;
      const returnType = m[2].trim();
      const rawParams = m[4].trim();
      const params: CppParam[] = [];
      if (rawParams !== '' && rawParams !== 'void') {
        for (const piece of splitParams(rawParams)) {
          const pm = piece.trim().match(/^(.*?[\w>&*\s])\s*([A-Za-z_]\w*)\s*$/);
          if (!pm) return null;
          params.push({ type: pm[1].trim(), name: pm[2] });
        }
      }
      if (!params.every((p) => isSupportedType(p.type))) return null;
      if (returnType !== 'void' && !isSupportedType(returnType)) return null;
      return { returnType, name, params };
    }
    return null;
  }

  async runBatch(
    code: string,
    _funcName: string,
    inputs: unknown[][],
    timeoutMs = 60_000,
    baselineCode?: string,
  ): Promise<RunBatchResult> {
    const sig = this.parseSignature(code);
    if (!sig) {
      return {
        compileError:
          'Could not parse the C++ function signature, or it uses a parameter type this tool does not support yet ' +
          '(supported: integer/floating/bool/char/std::string and std::vector of those, up to one level of nesting).',
      };
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'sbllm-cpp-'));
    const src = path.join(dir, 'harness.cpp');
    const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');

    try {
      writeFileSync(src, buildHarness(sig, code, baselineCode), 'utf8');

      // -O3 and C++17 to match the paper's own compilation settings (§IV-A).
      const compile = await run(CXX, ['-std=c++17', '-O3', '-o', exe, src], '', timeoutMs);
      if (compile.code !== 0) {
        return { compileError: firstCompilerError(compile.stderr) };
      }

      const payload = [
        String(inputs.length),
        ...inputs.map((args) => {
          const body = serializeArgs(sig.params, args);
          return `${body.length}\n${body}`;
        }),
      ].join('\n');

      const exec = await run(exe, [], payload, timeoutMs);
      const results = parseResults(exec.stdout, inputs.length);
      if (!results) return { compileError: `harness produced unreadable output: ${exec.stdout.slice(0, 300)}` };
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

function splitParams(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function firstCompilerError(stderr: string): string {
  const line = stderr
    .split('\n')
    .find((l) => /\berror\b/i.test(l));
  return (line ?? stderr.split('\n')[0] ?? 'compilation failed').trim().slice(0, 400);
}

function unescapeLine(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

function parseResults(stdout: string, expected: number): CallResult[] | null {
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
      const tail = rest.slice(sp2 + 1);
      const sep = tail.indexOf(' |STDOUT| ');
      const output = sep === -1 ? tail : tail.slice(0, sep);
      const stdoutText = sep === -1 ? '' : tail.slice(sep + ' |STDOUT| '.length);
      const entry: CallResult = {
        ok: true,
        output: parseEmitted(unescapeLine(output)),
        stdout: unescapeLine(stdoutText),
        timeMs: Number.isFinite(timeMs) ? timeMs : 0,
      };
      if (Number.isFinite(baselineMs) && baselineMs >= 0) entry.baselineTimeMs = baselineMs;
      results.push(entry);
    } else if (line.startsWith('ERR ')) {
      results.push({ ok: false, error: unescapeLine(line.slice(4)), timeMs: 0 });
    }
  }
  return results.length === expected ? results : results.length > 0 ? results : null;
}

/** Turns the harness's emitted value back into a JS value so deepAlmostEqual can compare it. */
function parseEmitted(text: string): unknown {
  const t = text.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function run(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`Could not run "${cmd}". Install a C++ compiler (g++) and make sure it is on your PATH.`)
          : err,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}
