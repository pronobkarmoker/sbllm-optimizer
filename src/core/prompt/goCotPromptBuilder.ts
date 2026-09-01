import type { Prompt } from '../llm/llmProvider.js';
import type { Candidate } from '../fitness/types.js';
import type { RetrievedPatterns } from '../pattern/patternRetriever.js';
import { extractJson } from '../util/json.js';

export interface GoCotResponse {
  analysis: string;
  opportunities: string;
  explanation: string;
  code: string;
}

/**
 * The GO-COT prompt from the paper's Fig. 3, adapted per ARCHITECTURE.md §6: strict JSON output
 * instead of the reference repo's regex/`.count()==1` markdown scraping (the exact class of bug
 * we fixed in merge.py's extract_py/extract_cpp — this design avoids it by construction).
 */
const SYSTEM = [
  'You are a senior software engineer specializing in code optimization.',
  'You will be given a slow code snippet, its existing optimization attempts with their measured',
  'correctness and speedup, and (optionally) two reference optimization patterns.',
  'Follow these steps: 1) analyze the original code and what the existing attempts already tried,',
  '2) identify additional optimization opportunities not yet used — combine the strengths of the',
  'existing attempts (crossover) and draw on the reference patterns for ideas not yet tried (mutation),',
  '3) explain your approach and produce ONE new, complete, correct, faster version of the function.',
  'The function name and parameter list must stay EXACTLY the same, including the number of ' +
    'parameters — it will be called the same way as the original. Do NOT turn hardcoded values ' +
    'into new parameters, even if that looks cleaner; keep them hardcoded inside the function body.',
  'Reference patterns (if shown) use a DIFFERENT example function with its own name and parameters ' +
    'purely to illustrate a technique — they are not a template to copy wholesale. Take only the ' +
    'TECHNIQUE from a pattern (e.g. "wrap the recursive call in @lru_cache") and apply it inside ' +
    'the ORIGINAL function\'s exact name and signature from "Slow code to optimize" below. Never ' +
    'adopt a pattern\'s function name or parameter list.',
  'If file context (imports, constants, other functions) is provided, it already exists elsewhere ' +
    'in the file and is available to your function as-is — do not redefine or repeat any of it in ' +
    'your answer, only return the function itself.',
  'Reply with strict JSON only, no markdown fences around the JSON itself, matching exactly:',
  '{"analysis": string, "opportunities": string, "explanation": string, "code": string}',
  'The "code" field must contain the full function source as a plain string (escape newlines as \\n).',
].join('\n');

function contextBlock(contextPrefix?: string): string {
  if (!contextPrefix?.trim()) return '';
  return [
    '',
    'File context available to this function (imports, constants, earlier functions — already',
    'defined elsewhere in the file; do not redefine any of this):',
    '```python',
    contextPrefix,
    '```',
  ].join('\n');
}

export function buildInitialPrompt(slowCode: string, contextPrefix?: string): Prompt {
  return {
    system: SYSTEM,
    user: [
      'Slow code to optimize:',
      '```python',
      slowCode,
      '```',
      contextBlock(contextPrefix),
      '',
      'There are no existing attempts yet — this is the first attempt. Produce an optimized version.',
    ].join('\n'),
  };
}

export function buildIterationPrompt(
  slowCode: string,
  representative: Candidate[],
  patterns: RetrievedPatterns,
  contextPrefix?: string,
): Prompt {
  const attempts = representative
    .map((c, i) => {
      const label = c.error
        ? 'An incorrect attempt'
        : (c.speedup ?? 1) > 1
          ? 'A correct and optimized attempt'
          : 'A correct but unoptimized attempt';
      return [
        `${label} ${i + 1}:`,
        '```python',
        c.code.trim(),
        '```',
        `Accuracy: ${c.acc ?? 0}  Speedup: ${(c.speedup ?? 1).toFixed(2)}x${c.error ? `  Error: ${c.error}` : ''}`,
      ].join('\n');
    })
    .join('\n\n');

  const patternText = [
    patterns.similar
      ? `Similar pattern (may help fix errors in the attempts above):\n${patterns.similar.description}\n- Before: ${patterns.similar.slow}\n- After: ${patterns.similar.fast}`
      : null,
    patterns.different
      ? `Different pattern (an unexploited technique to consider):\n${patterns.different.description}\n- Before: ${patterns.different.slow}\n- After: ${patterns.different.fast}`
      : null,
    patterns.similar || patterns.different
      ? 'Reminder: the pattern(s) above use their own example function name/parameters (e.g. ' +
        '"fib(n)") only to show the technique. Your answer must keep the exact function name and ' +
        'parameter list from "Slow code to optimize" — copying a pattern\'s signature is wrong.'
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    system: SYSTEM,
    user: [
      'Slow code to optimize:',
      '```python',
      slowCode,
      '```',
      contextBlock(contextPrefix),
      '',
      'Existing attempts so far:',
      attempts,
      patternText ? `\nReference optimization patterns:\n${patternText}` : '',
      '',
      'Propose a new, improved version that avoids the mistakes above and pushes optimization further.',
    ].join('\n'),
  };
}

export function parseGoCotResponse(text: string): GoCotResponse {
  const json = extractJson(text);
  if (json && typeof json.code === 'string') {
    return {
      analysis: json.analysis ?? '',
      opportunities: json.opportunities ?? '',
      explanation: json.explanation ?? '',
      code: unescapeIfOverEscaped(stripCodeFence(json.code)),
    };
  }

  // Smaller/local models don't always obey the "strict JSON" instruction — fall back to scraping
  // a fenced code block directly, same spirit as the reference repo's extraction, but only as a
  // fallback rather than the primary path. Explicitly excludes ```json fences: if the model wrapped
  // its (invalid) JSON envelope in one, that block is a failed structured response, not raw code,
  // and must not be executed as if it were.
  const fenced = text.match(/```(?!json\b)(?:python)?\s*([\s\S]*?)```/);
  if (fenced) {
    return { analysis: '', opportunities: '', explanation: text.trim(), code: unescapeIfOverEscaped(fenced[1].trim()) };
  }

  throw new Error(`Model response contained neither valid JSON nor a code block: ${text.slice(0, 300)}`);
}

function stripCodeFence(code: string): string {
  const fenced = code.match(/```(?:python)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : code).trim();
}

/**
 * Small/local models sometimes double-escape when writing the JSON "code" field — the model means
 * a real newline but writes the two literal characters "\\n" instead of a single JSON-escaped
 * newline, so after JSON.parse the string still contains literal backslash-n text instead of an
 * actual line break. Python then sees a bare backslash outside any string, which it interprets as
 * a line-continuation character, and raises "unexpected character after line continuation
 * character" — this exact error recurred across many runs before being traced to this. Detected by:
 * literal "\n" sequences present, but zero *real* newlines anywhere in the string (a correctly
 * escaped multi-line function always has real newlines once parsed).
 */
function unescapeIfOverEscaped(code: string): string {
  if (code.includes('\\n') && !code.includes('\n')) {
    return code.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
  return code;
}
