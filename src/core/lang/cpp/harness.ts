/**
 * Generates the C++ test harness that executes and times a candidate function.
 *
 * Python needs none of this: `exec()` the source, then call `func(*args)` with JSON-decoded values,
 * because the language is dynamically typed. C++ has to be told the types up front, so the harness
 * is generated per-function from the parsed signature — arguments are read with type-directed
 * readers and results written with type-directed writers.
 *
 * Deliberately no JSON parser on the C++ side. Both ends of this protocol are written here, so a
 * length-prefixed textual format is simpler and far less error-prone than hand-rolling JSON parsing
 * in C++. Lengths are in BYTES (UTF-8), matching what `istream::read` consumes.
 */
import { findCppFunctions } from './cppSource.js';

export interface CppParam {
  type: string;
  name: string;
  /** Non-const reference: the function can modify the caller's value, so every timed call needs
   *  its own fresh copy and the post-call value is part of the observable behaviour. */
  mutable: boolean;
}

export interface CppSignature {
  returnType: string;
  name: string;
  params: CppParam[];
}

/** Types the harness knows how to read as arguments and write as results. */
const SCALARS = new Set([
  'int',
  'long',
  'long long',
  'long int',
  'long long int',
  'short',
  'unsigned',
  'unsigned int',
  'unsigned long',
  'unsigned long long',
  'size_t',
  'int64_t',
  'int32_t',
  'uint64_t',
  'uint32_t',
  'float',
  'double',
  'long double',
  'bool',
  'char',
  'std::string',
]);
const INTEGER_TYPES = new Set([...SCALARS].filter((t) => !['float', 'double', 'long double', 'bool', 'char', 'std::string'].includes(t)));

export function normalizeType(raw: string): string {
  let t = raw.trim();
  // const / reference / whitespace noise: a `const std::vector<int>&` parameter is read exactly
  // like a `std::vector<int>` one — the qualifiers matter to the callee, not to how we build it.
  t = t.replace(/\bconst\b/g, ' ').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\bstd::/g, '');
  t = t.replace(/\b(u?int(?:8|16|32|64)_t)\b/g, '$1');
  t = t.replace(/\s*<\s*/g, '<').replace(/\s*>/g, '>');
  t = t.replace(/\bvector</g, 'std::vector<').replace(/\bstring\b/g, 'std::string');
  if (t === 'signed' || t === 'signed int') t = 'int';
  return t;
}

export function matchVector(t: string): string | null {
  const m = t.match(/^std::vector<(.+)>$/);
  return m ? m[1].trim() : null;
}

export function isSupportedType(raw: string): boolean {
  if (/\*/.test(raw)) return false;
  const t = normalizeType(raw);
  if (SCALARS.has(t)) return true;
  const inner = matchVector(t);
  if (!inner) return false;
  if (SCALARS.has(inner)) return true;
  const innerInner = matchVector(inner);
  return innerInner !== null && SCALARS.has(innerInner);
}

function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export type SignatureResult = { ok: true; sig: CppSignature } | { ok: false; reason: string };

/**
 * Finds `funcName` (or the first non-main function) among the namespace-scope definitions in `code`
 * and parses its signature. Looking the function up BY NAME matters: the code handed to the harness
 * is file context + candidate, and both commonly define helper functions above the target. Picking
 * "the first function" used to build a harness around the helper instead.
 */
export function parseCppSignature(code: string, funcName?: string): SignatureResult {
  const fns = findCppFunctions(code).filter((f) => f.name !== 'main');
  const all = funcName ? fns.filter((f) => f.name === funcName) : fns;
  // With overloads, the LAST definition wins: context comes first, the candidate last.
  const fn = all[all.length - 1];
  if (!fn) {
    return { ok: false, reason: funcName ? `no definition of \`${funcName}\` was found` : 'no function definition was found' };
  }
  if (fn.isTemplate) return { ok: false, reason: `\`${fn.name}\` is a template, which is not supported yet` };

  const params: CppParam[] = [];
  const raw = fn.paramsText.trim();
  if (raw !== '' && raw !== 'void') {
    for (const pieceRaw of splitTopLevel(raw)) {
      const piece = splitTopLevel(pieceRaw.replace(/=/, ',\u0000'))[0].trim(); // drop default values
      const pm = piece.match(/^(.*?[\w>&\s])\s*([A-Za-z_]\w*)\s*$/);
      if (!pm) return { ok: false, reason: `could not parse the parameter \`${pieceRaw.trim()}\`` };
      const type = pm[1].trim();
      if (!isSupportedType(type)) {
        return { ok: false, reason: `parameter \`${pm[2]}\` has type \`${type}\`, which is not supported yet` };
      }
      params.push({ type, name: pm[2], mutable: /&/.test(type) && !/\bconst\b/.test(type) });
    }
  }
  const returnType = fn.returnType;
  if (normalizeType(returnType) !== 'void' && !isSupportedType(returnType)) {
    return { ok: false, reason: `return type \`${returnType}\` is not supported yet` };
  }
  return { ok: true, sig: { returnType, name: fn.name, params } };
}

/**
 * Splits preprocessor directives and `using` declarations out of a translation unit. The candidate
 * and the original are compiled into the SAME binary so they can be timed against each other in one
 * process (the paired-baseline design), which means each has to live in its own namespace to avoid
 * redefinition. `#include` cannot appear inside a namespace, so directives are hoisted to the top.
 */
export function splitDirectives(code: string): { directives: string[]; body: string } {
  const directives: string[] = [];
  const bodyLines: string[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#')) {
      // Keep backslash-continued macros together.
      let directive = t;
      while (directive.endsWith('\\') && i + 1 < lines.length) directive += '\n' + lines[++i];
      if (!/^#\s*pragma\s+once\b/.test(directive)) directives.push(directive);
      bodyLines.push('');
    } else if (/^using\s+namespace\b/.test(t)) {
      directives.push(t);
      bodyLines.push('');
    } else {
      bodyLines.push(lines[i]);
    }
  }
  return { directives, body: bodyLines.join('\n') };
}

function readerFor(type: string, varName: string): string {
  const t = normalizeType(type);
  const inner = matchVector(t);
  if (inner) {
    const innerInner = matchVector(inner);
    if (innerInner) {
      return `${t} ${varName}; { long long n; in >> n; ${varName}.resize(n); for (long long i = 0; i < n; ++i) { long long m; in >> m; ${varName}[i].resize(m); for (long long j = 0; j < m; ++j) ${varName}[i][j] = read_scalar<${innerInner}>(in); } }`;
    }
    return `${t} ${varName}; { long long n; in >> n; ${varName}.resize(n); for (long long i = 0; i < n; ++i) ${varName}[i] = read_scalar<${inner}>(in); }`;
  }
  return `${t} ${varName} = read_scalar<${t}>(in);`;
}

/** Support code: scalar readers, and writers that both sides share so comparison is apples-to-apples. */
const SUPPORT = String.raw`
template <typename T> T read_scalar(std::istream& in) { long double v = 0; in >> v; return (T)v; }
template <> int read_scalar<int>(std::istream& in) { long long v = 0; in >> v; return (int)v; }
template <> long read_scalar<long>(std::istream& in) { long v = 0; in >> v; return v; }
template <> long long read_scalar<long long>(std::istream& in) { long long v = 0; in >> v; return v; }
template <> unsigned read_scalar<unsigned>(std::istream& in) { long long v = 0; in >> v; return (unsigned)v; }
template <> unsigned long read_scalar<unsigned long>(std::istream& in) { long long v = 0; in >> v; return (unsigned long)v; }
template <> unsigned long long read_scalar<unsigned long long>(std::istream& in) { long long v = 0; in >> v; return (unsigned long long)v; }
template <> float read_scalar<float>(std::istream& in) { double v = 0; in >> v; return (float)v; }
template <> double read_scalar<double>(std::istream& in) { double v = 0; in >> v; return v; }
template <> bool read_scalar<bool>(std::istream& in) { int v = 0; in >> v; return v != 0; }
template <> std::string read_scalar<std::string>(std::istream& in) {
  long long n = 0; in >> n; in.get();  // consume the separator after the length
  std::string s; s.resize(n);
  if (n > 0) in.read(&s[0], n);
  return s;
}
template <> char read_scalar<char>(std::istream& in) {
  std::string s = read_scalar<std::string>(in);
  return s.empty() ? '\0' : s[0];
}

static void write_json_string(std::ostream& os, const std::string& v) {
  os << '"';
  for (unsigned char c : v) {
    switch (c) {
      case '"': os << "\\\""; break;
      case '\\': os << "\\\\"; break;
      case '\n': os << "\\n"; break;
      case '\r': os << "\\r"; break;
      case '\t': os << "\\t"; break;
      default:
        if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); os << buf; }
        else os << (char)c;
    }
  }
  os << '"';
}
static void write_value(std::ostream& os, bool v) { os << (v ? "true" : "false"); }
static void write_value(std::ostream& os, char v) { write_json_string(os, std::string(1, v)); }
static void write_value(std::ostream& os, const std::string& v) { write_json_string(os, v); }
static void write_value(std::ostream& os, long double v) {
  if (std::isnan((double)v)) { os << "\"NaN\""; return; }
  if (std::isinf((double)v)) { os << (v > 0 ? "\"Infinity\"" : "\"-Infinity\""); return; }
  if (v == (long long)v && std::fabs((double)v) < 1e15) os << (long long)v;
  else { std::ostringstream t; t.precision(15); t << (double)v; os << t.str(); }
}
static void write_value(std::ostream& os, double v) { write_value(os, (long double)v); }
static void write_value(std::ostream& os, float v) { write_value(os, (long double)v); }
template <typename T> static void write_value(std::ostream& os, const T& v) { os << v; }
template <typename T> static void write_value(std::ostream& os, const std::vector<T>& v) {
  os << '[';
  for (size_t i = 0; i < v.size(); ++i) { if (i) os << ','; write_value(os, (T)v[i]); }
  os << ']';
}

/**
 * Keeps the optimizer from deleting the very thing being measured. At -O3 (the paper's flag) a call
 * whose result is discarded in a timing loop is dead code, and GCC removes it outright — which made
 * an O(n^2) scan over 4000 elements report 0.0006 ms before this existed. Every timed call feeds its
 * result into a volatile sink and is followed by a compiler barrier, so the work must actually happen.
 */
static volatile long long g_sink = 0;
static inline void sink(bool v) { g_sink += v ? 1 : 0; }
static inline void sink(char v) { g_sink += (long long)v; }
static inline void sink(const std::string& v) { g_sink += (long long)v.size(); if (!v.empty()) g_sink += (long long)v[0]; }
template <typename T> static inline void sink(const T& v) { g_sink += (long long)v; }
template <typename T> static inline void sink(const std::vector<T>& v) {
  g_sink += (long long)v.size();
  if (!v.empty()) sink((T)v[0]);
}
#if defined(__GNUC__) || defined(__clang__)
  #define SBLLM_BARRIER() asm volatile("" ::: "memory")
#else
  #define SBLLM_BARRIER() do { } while (0)
#endif

/** Restores std::cout's buffer on scope exit — including when the function under test throws.
 *  Without this, an exception left cout pointing at a destroyed stringstream, and every later
 *  result line in the batch was lost (or the harness crashed). */
struct CoutRedirect {
  std::streambuf* old;
  explicit CoutRedirect(std::streambuf* to) : old(std::cout.rdbuf(to)) {}
  ~CoutRedirect() { std::cout.rdbuf(old); }
};

/** Swallows output from the timed repeats. Buffering it instead grew without bound for a function
 *  that prints, across up to 200k repetitions. */
struct NullBuf : std::streambuf {
  int overflow(int c) override { return c; }
  std::streamsize xsputn(const char*, std::streamsize n) override { return n; }
};
static NullBuf g_null_buf;

/** Escapes a string so one result occupies exactly one line of the protocol. */
static std::string escape_line(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') {}
    else out += c;
  }
  return out;
}
`;

/**
 * Timing mirrors the Python harness, so a speedup means the same thing in both languages: one call
 * for correctness, then either a handful of individually-timed repeats (slow calls, median taken) or
 * a batched run (fast calls), and the baseline re-timed in the same process immediately alongside
 * the candidate so environmental drift cancels out of the ratio.
 */
function callBlock(sig: CppSignature, ns: string, timeVar: string, capture: boolean): string {
  const argNames = sig.params.map((_, i) => `a${i}`);
  const isVoid = normalizeType(sig.returnType) === 'void';
  const mutable = sig.params.map((p, i) => (p.mutable ? i : -1)).filter((i) => i >= 0);
  const hasMutable = mutable.length > 0;
  const callWith = (names: string[]) => `${ns}::${sig.name}(${names.join(', ')})`;
  const timedCall = (names: string[]) =>
    isVoid ? `${callWith(names)}; SBLLM_BARRIER();` : `sink(${callWith(names)}); SBLLM_BARRIER();`;

  const declareArgs = sig.params.map((p, i) => `      ${readerFor(p.type, `a${i}`)}`).join('\n');
  const reReadArgs = sig.params.map((p, i) => `        ${readerFor(p.type, `a${i}`)}`).join('\n');

  // Fast path with mutable (non-const reference) params: every call needs its own pristine copy,
  // prepared before the clock starts. Calling repeatedly on the same object would time, say, an
  // in-place sort on already-sorted data after the first call.
  const copies = hasMutable
    ? sig.params.map((p, i) => (p.mutable ? `        std::vector<decltype(a${i})> c${i}((size_t)reps, a${i});` : '')).join('\n')
    : '';
  const fastArgs = sig.params.map((p, i) => (p.mutable ? `c${i}[(size_t)rep]` : `a${i}`));

  return `
    {
      std::istringstream in(payload);
${declareArgs}
      std::ostringstream captured;
      double first_ms = 0;
      {
        CoutRedirect guard(captured.rdbuf());
        auto t0 = std::chrono::steady_clock::now();
        ${isVoid ? `${callWith(argNames)}; SBLLM_BARRIER();` : `auto r = ${callWith(argNames)}; SBLLM_BARRIER();`}
        auto t1 = std::chrono::steady_clock::now();
        first_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        ${capture ? (isVoid ? `result = "null";` : `{ std::ostringstream rs; write_value(rs, r); result = rs.str(); }`) : ''}
      }
      ${capture ? `captured_out = captured.str();` : ''}
      ${
        capture && hasMutable
          ? `{ std::ostringstream as; as << '['; ${mutable
              .map((i, k) => `${k ? `as << ',';` : ''} write_value(as, a${i});`)
              .join(' ')} as << ']'; args_after = as.str(); }`
          : ''
      }

      double budget_ms = 2000.0;
      if (!g_timing) {
        ${timeVar} = first_ms;  // correctness-only run: no repeated timing
      } else if (first_ms >= 100.0) {
        std::vector<double> times; times.push_back(first_ms);
        auto start = std::chrono::steady_clock::now();
        for (int rep = 0; rep < 8; ++rep) {
          if (std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() > budget_ms) break;
          std::istringstream in2(payload);
          std::istream& in = in2;
${reReadArgs}
          CoutRedirect guard(&g_null_buf);
          auto s0 = std::chrono::steady_clock::now();
          ${timedCall(argNames)}
          auto s1 = std::chrono::steady_clock::now();
          times.push_back(std::chrono::duration<double, std::milli>(s1 - s0).count());
        }
        std::sort(times.begin(), times.end());
        ${timeVar} = times[times.size() / 2];
      } else {
        double per = first_ms > 0 ? first_ms : 1e-4;
        long long reps = (long long)(150.0 / per);
        if (reps < 10) reps = 10;
        if (reps > ${hasMutable ? 2000 : 200000}) reps = ${hasMutable ? 2000 : 200000};
        std::istringstream in3(payload);
        std::istream& in = in3;
${reReadArgs}
${copies}
        CoutRedirect guard(&g_null_buf);
        auto b0 = std::chrono::steady_clock::now();
        long long done = 0;
        for (long long rep = 0; rep < reps; ++rep) {
          ${timedCall(fastArgs)}
          ++done;
          if ((rep & 63) == 0 &&
              std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - b0).count() > budget_ms) break;
        }
        auto b1 = std::chrono::steady_clock::now();
        ${timeVar} = std::chrono::duration<double, std::milli>(b1 - b0).count() / (double)(done > 0 ? done : 1);
      }
    }`;
}

export function buildHarness(sig: CppSignature, candidate: string, baseline?: string): string {
  const cand = splitDirectives(candidate);
  const base = baseline ? splitDirectives(baseline) : null;
  const directives = Array.from(new Set([...cand.directives, ...(base?.directives ?? [])]));

  // The common STL headers are included unconditionally. We control this translation unit, and a
  // candidate that is algorithmically correct shouldn't be discarded purely because the model left
  // out an #include — that was rejecting otherwise-good unordered_set rewrites outright.
  return `#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_set>
#include <unordered_map>
#include <set>
#include <map>
#include <deque>
#include <queue>
#include <stack>
#include <numeric>
#include <utility>
#include <functional>
#include <limits>
#include <cstdint>
#include <cstring>
#include <bitset>
#include <array>
#include <tuple>
${directives.join('\n')}

${SUPPORT}

namespace cand {
${cand.body}
}
${base ? `namespace base {\n${base.body}\n}` : ''}

static bool g_timing = true;

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) if (std::string(argv[i]) == "--no-timing") g_timing = false;
  std::ios::sync_with_stdio(false);
  int n_cases = 0;
  if (!(std::cin >> n_cases)) { std::cout << "COMPILE_OK 0\\n"; return 0; }
  std::cin.get();

  std::cout << "COMPILE_OK " << n_cases << "\\n" << std::flush;

  for (int c = 0; c < n_cases; ++c) {
    long long len = 0;
    std::cin >> len;
    std::cin.get();
    std::string payload;
    payload.resize(len);
    if (len > 0) std::cin.read(&payload[0], len);
    std::cin.get();

    std::string result = "null";
    std::string captured_out;
    std::string args_after = "null";
    double cand_ms = 0.0;
    double base_ms = -1.0;
    bool ok = true;
    std::string err;

    try {
${callBlock(sig, 'cand', 'cand_ms', true)}
    } catch (const std::exception& e) { ok = false; err = std::string("exception: ") + e.what(); }
      catch (...) { ok = false; err = "unknown C++ exception"; }

${
  base
    ? `    if (ok && g_timing) {
      try {
${callBlock(sig, 'base', 'base_ms', false)}
      } catch (...) { base_ms = -1.0; }
    }`
    : ''
}

    if (ok) {
      std::cout << "OK " << cand_ms << " " << base_ms << " "
                << escape_line(result) << " |STDOUT| " << escape_line(captured_out)
                << " |ARGS| " << escape_line(args_after) << "\\n" << std::flush;
    } else {
      std::cout << "ERR " << escape_line(err) << "\\n" << std::flush;
    }
  }
  return 0;
}
`;
}

/** Serializes one call's arguments into the harness's length-prefixed textual format. */
export function serializeArgs(params: CppParam[], args: unknown[]): string {
  const parts: string[] = [];
  const emit = (type: string, value: unknown): void => {
    const t = normalizeType(type);
    const inner = matchVector(t);
    if (inner) {
      const arr = Array.isArray(value) ? value : [];
      parts.push(String(arr.length));
      for (const v of arr) emit(inner, v);
      return;
    }
    if (t === 'std::string' || t === 'char') {
      const s = value === null || value === undefined ? '' : String(value);
      // Byte length, not String.length: the reader consumes bytes, and any non-ASCII character
      // would otherwise desynchronize every value after it.
      parts.push(String(Buffer.byteLength(s, 'utf8')));
      parts.push(s);
      return;
    }
    if (t === 'bool') {
      parts.push(value ? '1' : '0');
      return;
    }
    let num = typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : Number(value ?? 0);
    if (!Number.isFinite(num)) num = 0;
    if (INTEGER_TYPES.has(t)) num = Math.trunc(num);
    parts.push(String(num));
  };
  params.forEach((p, i) => emit(p.type, args[i]));
  return parts.join('\n');
}
