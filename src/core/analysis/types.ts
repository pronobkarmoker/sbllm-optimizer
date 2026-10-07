import type { LanguageId } from '../lang/languageAdapter.js';

export type IssueSeverity = 'warning' | 'info' | 'hint';

/** One detected inefficiency. All positions are 0-based (VS Code convention). */
export interface AnalysisIssue {
  kind: string;
  severity: IssueSeverity;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  suggestion: string;
}

export interface FunctionAnalysis {
  name: string;
  /** First line of the function, including decorators / template prefix. */
  startLine: number;
  endLine: number;
  /** Only top-level (namespace-scope) functions can be optimized; methods are analyzed but not offered. */
  topLevel: boolean;
  /** Rough asymptotic estimate from loop nesting and recursion, e.g. "O(n^2)" or "exponential". */
  complexity: string;
  issues: AnalysisIssue[];
}

export interface FileAnalysis {
  language: LanguageId;
  functions: FunctionAnalysis[];
  /** Set when the file could not be analyzed (e.g. a syntax error). */
  error?: string;
}
