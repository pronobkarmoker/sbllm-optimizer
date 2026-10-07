import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ProcessResult {
  /** null when the process was killed (timeout) or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the executable could not be started at all (e.g. not installed / not on PATH). */
  spawnError?: string;
}

/**
 * Runs a child process to completion and NEVER rejects. Every failure mode — timeout, crash,
 * missing executable — comes back as data. This is deliberate: the processes run here execute
 * LLM-generated code, so "it blew up" is an expected outcome to score (acc = 0), not an exception
 * that may unwind the whole search. A rejecting runner is what used to let a single candidate that
 * called sys.exit() or looped forever abort an entire optimization session.
 */
export function runProcess(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, windowsHide: true });
    } catch (err) {
      finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (err as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      // Bounded: a candidate stuck printing in a loop must not exhaust the extension host's memory.
      if (stdout.length < 20_000_000) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < 1_000_000) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        spawnError:
          code === 'ENOENT'
            ? `Could not run "${path.basename(cmd)}" — it is not installed or not on your PATH.`
            : err.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut });
    });

    // EPIPE when the child exits before reading stdin is a normal outcome here, not a crash.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}
