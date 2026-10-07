import type { LanguageId } from '../lang/languageAdapter.js';
import { PythonAdapter } from '../lang/pythonAdapter.js';
import { analyzeCpp } from './cppAnalyzer.js';
import { refineComplexity } from './complexity.js';
import type { AnalysisIssue, FileAnalysis, FunctionAnalysis } from './types.js';

export type { AnalysisIssue, FileAnalysis, FunctionAnalysis } from './types.js';

interface RawPyIssue {
  kind: string;
  severity: AnalysisIssue['severity'];
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  suggestion: string;
}

interface RawPyFunction {
  name: string;
  line: number;
  endLine: number;
  topLevel: boolean;
  complexity: string;
  issues: RawPyIssue[];
}

/**
 * "Intelligent Code Analysis": statically flags inefficient code so the (expensive, LLM-driven)
 * search is pointed at functions that are worth optimizing. Python is analyzed with the `ast`
 * module (analyze.py — parsing only, nothing is executed); C++ with the in-process source scanner.
 */
export class CodeAnalyzer {
  private readonly python: PythonAdapter;

  constructor(opts: { scriptsDir: string; pythonPath?: string }) {
    this.python = new PythonAdapter(opts.scriptsDir, { pythonPath: opts.pythonPath });
  }

  async analyze(code: string, language: LanguageId): Promise<FileAnalysis> {
    if (language === 'cpp') {
      const res = analyzeCpp(code);
      return { ...res, functions: res.functions.map(refineComplexity) };
    }

    let raw: { ok?: boolean; error?: string; functions?: RawPyFunction[] } | null;
    try {
      raw = (await this.python.analyze(code)) as typeof raw;
    } catch (err) {
      return { language, functions: [], error: (err as Error).message };
    }
    if (!raw) return { language, functions: [], error: 'the Python analyzer produced no output' };
    if (raw.ok === false) return { language, functions: [], error: raw.error ?? 'analysis failed' };

    const functions: FunctionAnalysis[] = (raw.functions ?? []).map((f) => ({
      name: f.name,
      startLine: f.line - 1,
      endLine: f.endLine - 1,
      topLevel: f.topLevel,
      complexity: f.complexity,
      issues: f.issues.map((i) => ({
        ...i,
        line: i.line - 1,
        endLine: i.endLine - 1,
      })),
    }));
    return { language, functions: functions.map(refineComplexity) };
  }
}
