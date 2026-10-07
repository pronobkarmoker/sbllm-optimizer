import type { Prompt } from '../llm/llmProvider.js';
import type { Candidate } from '../fitness/types.js';
import type { RetrievedPattern, RetrievedPatterns } from '../pattern/patternRetriever.js';
import { extractJson } from '../util/json.js';
import { LANGUAGE_META, type LanguageId } from '../lang/languageAdapter.js';

export interface GoCotResponse {
  analysis: string;
  opportunities: string;
  explanation: string;
  code: string;
}

function signatureRules(lang: LanguageId): string[] {
  return [
    'The function name and parameter list must stay EXACTLY the same, including the number of parameters — ' +
      'it will be called the same way as the original. Do NOT turn hardcoded values into new parameters.',
    'The new version must behave identically to the original for every valid input: same return value, same ' +
      'printed output, and the same effect on any argument it modifies.',
    'You may define helper functions above the target function if that helps.',
    `If file context (${lang === 'python' ? 'imports, constants, other functions' : '#includes, constants, other functions'}) ` +
      'is provided, it already exists in the file and is available as-is — do not repeat or redefine it; return only ' +
      'the function (plus any NEW helpers/imports it needs).',
    ...(lang === 'cpp'
      ? [
          'Keep any #include directives your version needs at the top of the "code" field.',
          'It is compiled with -std=c++17 -O3, so the compiler already performs trivial transformations — ' +
            'focus on algorithmic and data-structure improvements it cannot make for you.',
        ]
      : []),
  ];
}

const JSON_SPEC =
  'Reply with strict JSON only (no markdown fences around the JSON), with exactly these keys:\n' +
  '{"analysis": string, "opportunities": string, "explanation": string, "code": string}\n' +
  'The "code" field holds the complete source as one JSON string (newlines escaped as \\n).';

function contextBlock(lang: LanguageId, contextPrefix?: string): string {
  if (!contextPrefix?.trim()) return '';
  return [
    '',
    'File context available to this function (already defined in the file; do not redefine any of it):',
    '```' + LANGUAGE_META[lang].fence,
    contextPrefix.trimEnd(),
    '```',
  ].join('\n');
}

/**
 * Initial population. The paper seeds SBLLM with "optimized code of S_t obtained using existing
 * optimization techniques"; its strongest baseline, and what this uses, is chain-of-thought
 * prompting: explain how to optimize the program, then produce the optimized code.
 */
export function buildInitialPrompt(lang: LanguageId, slowCode: string, contextPrefix?: string): Prompt {
  const L = LANGUAGE_META[lang].label;
  return {
    system: [
      `You are a senior software engineer specializing in ${L} performance optimization.`,
      'Optimize the given function for execution speed. First explain step by step what makes it slow and how to ',
      'optimize it, then write the optimized function.',
      ...signatureRules(lang),
      '',
      'Desired output format:',
      JSON_SPEC,
      '- "analysis": what the code does and where its time goes (complexity, redundant work).',
      '- "opportunities": the optimization methods you will apply.',
      '- "explanation": a short summary of the final optimization points.',
    ].join('\n'),
    user: [
      'Slow code to optimize:',
      '```' + LANGUAGE_META[lang].fence,
      slowCode.trimEnd(),
      '```',
      contextBlock(lang, contextPrefix),
      '',
      'Explain how to optimize this function, then provide the optimized version.',
    ].join('\n'),
  };
}

function describeAttempt(c: Candidate): string {
  if (c.acc !== 1) return 'Incorrect version';
  if (c.speedup >= 1.1) return `Correct version, ${c.speedup.toFixed(2)}x faster than the original`;
  if (c.speedup < 0.95) return `Correct version, but SLOWER than the original (${c.speedup.toFixed(2)}x)`;
  return 'Correct version, but not faster than the original';
}

function patternBlock(title: string, purpose: string, p: RetrievedPattern | null): string | null {
  if (!p) return null;
  return [
    `${title} (${purpose}):`,
    ...(p.pattern.description ? [p.pattern.description] : []),
    '```diff',
    p.diff,
    '```',
  ].join('\n');
}

/**
 * The GO-COT prompt (paper §II-D, Fig. 3): genetic-operator-incorporated instructions (crossover,
 * mutation, generation), a reasoning specification fixing the output format step by step, and the
 * input placeholder — slow code, current representative versions with measured performance, and the
 * similar/different patterns. The reasoning specification is expressed as JSON keys instead of the
 * reference repo's markdown headings, so the answer can be parsed without regex scraping.
 */
export function buildIterationPrompt(
  lang: LanguageId,
  slowCode: string,
  representative: Candidate[],
  patterns: RetrievedPatterns,
  contextPrefix?: string,
): Prompt {
  const L = LANGUAGE_META[lang].label;
  const fence = LANGUAGE_META[lang].fence;

  const system = [
    `You are a senior software engineer specializing in ${L} performance optimization.`,
    'Task Description & Instructions: You will be provided with a code snippet, its existing optimization versions ',
    'along with their measured correctness and performance, and two code transformation patterns. Your task is to ',
    'propose a more efficient optimization method to achieve a higher speedup. Refer to the existing versions and ',
    'avoid the mistakes made in incorrect and unoptimized versions. Follow these steps:',
    '1. [Crossover] Analyze the original code and the optimizations applied in the existing versions — identify the ',
    '   strengths of each correct version and how they can be COMBINED, and why any incorrect version failed.',
    '2. [Mutation] Identify any additional optimization opportunities that have not been utilized yet, drawing on ',
    '   the transformation patterns. Patterns use their OWN example code; take only the TECHNIQUE, never their ',
    '   function names, variables or parameter lists.',
    '3. [Generation] Explain your optimization methods and provide ONE new, complete, correct, faster version.',
    ...signatureRules(lang),
    '',
    'Reasoning specification — desired output format:',
    JSON_SPEC,
    '- "analysis": your answer to step 1.',
    '- "opportunities": your answer to step 2.',
    '- "explanation": the optimization points of step 3.',
    '- "code": the new optimized code of step 3.',
  ].join('\n');

  const attempts = representative
    .map((c, i) =>
      [
        `[Version ${i + 1}] ${describeAttempt(c)}:`,
        '```' + fence,
        c.code.trim(),
        '```',
        `Accuracy: ${c.acc.toFixed(2)}` +
          (c.acc === 1 && c.avgTimeMs !== null && c.baselineTimeMs !== null
            ? `  Time: ${formatMs(c.avgTimeMs)} vs original ${formatMs(c.baselineTimeMs)}`
            : '') +
          (c.error ? `\nError: ${c.error}` : ''),
      ].join('\n'),
    )
    .join('\n\n');

  const patternText = [
    patternBlock('Pattern 1 — similar', 'may help rectify errors in the existing versions', patterns.similar),
    patternBlock('Pattern 2 — different', 'an optimization method not yet exploited', patterns.different),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    system,
    user: [
      'The code you need to optimize:',
      '```' + fence,
      slowCode.trimEnd(),
      '```',
      contextBlock(lang, contextPrefix),
      '',
      'Some existing versions with their performance:',
      attempts || '(none yet)',
      patternText ? `\nCode transformation patterns:\n${patternText}` : '',
      '',
      'Please follow the above instructions and output format specification step by step to generate a better program.',
    ].join('\n'),
  };
}

function formatMs(ms: number): string {
  return ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`;
}

export function parseGoCotResponse(text: string): GoCotResponse {
  const json = extractJson(text);
  if (json && typeof json.code === 'string') {
    return {
      analysis: asText(json.analysis),
      opportunities: asText(json.opportunities),
      explanation: asText(json.explanation),
      code: unescapeIfOverEscaped(stripCodeFence(json.code)),
    };
  }

  // Smaller/local models don't always obey the "strict JSON" instruction — fall back to the LAST
  // fenced code block (the reasoning may quote the original first). ```json fences are excluded: a
  // model that wrapped its (invalid) JSON envelope in one produced a failed structured response,
  // not raw code, and that must not be executed as if it were.
  const blocks = [...text.matchAll(/```(?!json\b|diff\b)(?:python|py|cpp|c\+\+|cc)?[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (last) {
    return { analysis: '', opportunities: '', explanation: text.replace(last[0], '').trim(), code: unescapeIfOverEscaped(last[1].trim()) };
  }

  throw new Error(`Model response contained neither valid JSON nor a code block: ${text.slice(0, 300)}`);
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? `- ${x}` : JSON.stringify(x))).join('\n');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return '';
}

function stripCodeFence(code: string): string {
  const fenced = code.match(/```(?:python|py|cpp|c\+\+|cc)?[^\n]*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : code).trim();
}

/**
 * Small/local models sometimes double-escape when writing the JSON "code" field — the model means
 * a real newline but writes the two literal characters "\\n" instead, so after JSON.parse the
 * string still contains literal backslash-n text instead of line breaks. Detected by: literal "\n"
 * sequences present, but zero *real* newlines anywhere in the string.
 */
function unescapeIfOverEscaped(code: string): string {
  if (code.includes('\\n') && !code.includes('\n')) {
    return code.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
  return code;
}
