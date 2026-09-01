import { pythonPatterns } from './data/pythonPatterns.js';

export interface Pattern {
  id: string;
  tags: string[];
  description: string;
  slow: string;
  fast: string;
}

/**
 * Loads the curated pattern base described in ARCHITECTURE.md §4 — a small, hand-picked set of
 * classic optimization idioms, standing in for the PIE-mined corpus the paper uses. Phase 3 swaps
 * the data module this reads for offline-mined PIE patterns without touching callers.
 */
export function loadPatternBase(lang: 'python'): Pattern[] {
  if (lang === 'python') return pythonPatterns;
  throw new Error(`No pattern base available for language: ${lang}`);
}
