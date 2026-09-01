/** Best-effort JSON extraction from an LLM response: handles ```json fences and stray prose around the object. */
export function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = normalizeTripleQuotedStrings(fenced ? fenced[1] : trimmed);
  candidate = stripJsonComments(candidate);
  candidate = candidate.replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Smaller/local models sometimes use Python triple-quoted strings for multi-line values instead
 *  of a properly-escaped JSON string — reformat those spans into valid JSON before parsing. */
function normalizeTripleQuotedStrings(text: string): string {
  return text.replace(/"""([\s\S]*?)"""/g, (_match, inner: string) => JSON.stringify(inner));
}

/** Strips JS/JSON5-style // and /* *\/ comments, and Python-style # comments, some models add —
 *  string-boundary aware, so it never touches these characters appearing legitimately inside an
 *  actual string value (e.g. a URL, a hex color, or a comment inside embedded source code). Must
 *  run after triple-quote normalization so any triple-quoted spans are already proper quoted
 *  strings by the time this scans for boundaries. */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === '\\') {
        result += next ?? '';
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '#') {
      inLineComment = true;
      continue;
    }
    result += c;
  }

  return result;
}
