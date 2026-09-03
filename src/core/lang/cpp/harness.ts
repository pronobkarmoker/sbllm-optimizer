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
 * in C++. Correctness comparison still works the same way as Python's: both the original and the
 * candidate are serialized through the identical writer, so comparing the emitted strings compares
 * behaviour.
 */

export interface CppParam {
  type: string;
  name: string;
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
  'unsigned',
  'unsigned int',
  'unsigned long',
  'unsigned long long',
  'size_t',
  'float',
  'double',
  'bool',
  'char',
  'std::string',
  'string',
]);

function normalizeType(raw: string): string {
  let t = raw.trim();
  // const / reference / whitespace noise: a `const std::vector<int>&` parameter is read exactly
  // like a `std::vector<int>` one — the qualifiers matter to the callee, not to how we build it.
  t = t.replace(/\bconst\b/g, ' ').replace(/[&]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === 'string') t = 'std::string';
  t = t.replace(/\bvector\s*</g, 'std::vector<').replace(/std::std::/g, 'std::');
  t = t.replace(/\bstring\b/g, 'std::string').replace(/std::std::/g, 'std::');
  return t;
}

export function isSupportedType(raw: string): boolean {
  const t = normalizeType(raw);
  if (SCALARS.has(t)) return true;
  const inner = matchVector(t);
  if (inner) return SCALARS.has(inner) || (matchVector(inner) ? SCALARS.has(matchVector(inner)!) : false);
  return false;
}

function matchVector(t: string): string | null {
  const m = t.match(/^std::vector<(.+)>$/);
  return m ? m[1].trim() : null;
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
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') || /^using\s+namespace\b/.test(t) || /^using\s+\w+\s*=/.test(t)) {
      directives.push(t);
    } else {
      bodyLines.push(line);
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
const SUPPORT = `
template <typename T> T read_scalar(std::istream& in);
template <> int read_scalar<int>(std::istream& in) { int v; in >> v; return v; }
template <> long read_scalar<long>(std::istream& in) { long v; in >> v; return v; }
template <> long long read_scalar<long long>(std::istream& in) { long long v; in >> v; return v; }
template <> unsigned read_scalar<unsigned>(std::istream& in) { unsigned v; in >> v; return v; }
template <> unsigned long read_scalar<unsigned long>(std::istream& in) { unsigned long v; in >> v; return v; }
template <> unsigned long long read_scalar<unsigned long long>(std::istream& in) { unsigned long long v; in >> v; return v; }
template <> float read_scalar<float>(std::istream& in) { float v; in >> v; return v; }
template <> double read_scalar<double>(std::istream& in) { double v; in >> v; return v; }
template <> bool read_scalar<bool>(std::istream& in) { int v; in >> v; return v != 0; }
template <> char read_scalar<char>(std::istream& in) { long long n; in >> n; std::string s; s.resize(n); in.read(&s[0], n); return n > 0 ? s[0] : '\\0'; }
template <> std::string read_scalar<std::string>(std::istream& in) {
  long long n; in >> n; in.get();
  std::string s; s.resize(n);
  if (n > 0) in.read(&s[0], n);
  return s;
}

static void write_value(std::ostream& os, bool v) { os << (v ? "true" : "false"); }
static void write_value(std::ostream& os, char v) { os << '"' << v << '"'; }
static void write_value(std::ostream& os, const std::string& v) { os << '"' << v << '"'; }
static void write_value(std::ostream& os, double v) {
  if (v == (long long)v && std::abs(v) < 1e15) os << (long long)v; else { os.precision(12); os << v; }
}
static void write_value(std::ostream& os, float v) { write_value(os, (double)v); }
template <typename T> static void write_value(std::ostream& os, const T& v) { os << v; }
template <typename T> static void write_value(std::ostream& os, const std::vector<T>& v) {
  os << '[';
  for (size_t i = 0; i < v.size(); ++i) { if (i) os << ','; write_value(os, v[i]); }
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
  if (!v.empty()) sink(v[0]);
}
#if defined(__GNUC__) || defined(__clang__)
  #define SBLLM_BARRIER() asm volatile("" ::: "memory")
#else
  #define SBLLM_BARRIER() do { } while (0)
#endif

/** Escapes a string so one result occupies exactly one line of the protocol. */
static std::string escape_line(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '\\\\') out += "\\\\\\\\";
    else if (c == '\\n') out += "\\\\n";
    else if (c == '\\r') out += "";
    else out += c;
  }
  return out;
}
`;

/**
 * Timing mirrors the Python harness exactly, so a speedup means the same thing in both languages:
 * one call for correctness, then either a handful of individually-timed repeats (slow calls, median
 * taken) or a batched run (fast calls), and the baseline re-timed in the same process immediately
 * alongside the candidate so environmental drift cancels out of the ratio.
 */
function callBlock(sig: CppSignature, ns: string, resultVar: string, timeVar: string, captureOut: boolean): string {
  const argNames = sig.params.map((_, i) => `a${i}`);
  const call = `${ns}::${sig.name}(${argNames.join(', ')})`;
  const isVoid = normalizeType(sig.returnType) === 'void';
  // Timed invocations route through sink()/barrier so -O3 cannot delete them as dead code.
  const timedCall = isVoid ? `${call}; SBLLM_BARRIER();` : `sink(${call}); SBLLM_BARRIER();`;

  const declareArgs = sig.params.map((p, i) => `      ${readerFor(p.type, `a${i}`)}`).join('\n');
  const reReadArgs = sig.params.map((p, i) => `        ${readerFor(p.type, `a${i}`)}`).join('\n');

  return `
    {
      std::istringstream in(payload);
${declareArgs}
      std::ostringstream captured;
      std::streambuf* old = std::cout.rdbuf(${captureOut ? 'captured.rdbuf()' : 'captured.rdbuf()'});
      auto t0 = std::chrono::steady_clock::now();
      ${isVoid ? `${call}; SBLLM_BARRIER();` : `auto r = ${call}; SBLLM_BARRIER();`}
      auto t1 = std::chrono::steady_clock::now();
      std::cout.rdbuf(old);
      double first_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
      ${isVoid ? `${resultVar} = "null";` : `{ std::ostringstream rs; write_value(rs, r); ${resultVar} = rs.str(); }`}
      ${captureOut ? `captured_out = captured.str();` : ''}

      double budget_ms = 2000.0;
      if (first_ms >= 100.0) {
        std::vector<double> times; times.push_back(first_ms);
        auto start = std::chrono::steady_clock::now();
        for (int rep = 0; rep < 8; ++rep) {
          if (std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() > budget_ms) break;
          std::istringstream in2(payload);
          std::istream& in = in2;
${reReadArgs}
          std::streambuf* o2 = std::cout.rdbuf(captured.rdbuf());
          auto s0 = std::chrono::steady_clock::now();
          ${timedCall}
          auto s1 = std::chrono::steady_clock::now();
          std::cout.rdbuf(o2);
          times.push_back(std::chrono::duration<double, std::milli>(s1 - s0).count());
        }
        std::sort(times.begin(), times.end());
        ${timeVar} = times[times.size() / 2];
      } else {
        double per = first_ms > 0 ? first_ms : 1e-4;
        long long reps = (long long)(150.0 / per);
        if (reps < 10) reps = 10;
        if (reps > 200000) reps = 200000;
        std::istringstream in3(payload);
        std::istream& in = in3;
${reReadArgs}
        std::streambuf* o3 = std::cout.rdbuf(captured.rdbuf());
        auto b0 = std::chrono::steady_clock::now();
        long long done = 0;
        for (long long rep = 0; rep < reps; ++rep) {
          ${timedCall}
          ++done;
          if ((rep & 63) == 0 &&
              std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - b0).count() > budget_ms) break;
        }
        auto b1 = std::chrono::steady_clock::now();
        std::cout.rdbuf(o3);
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
${directives.join('\n')}

${SUPPORT}

namespace cand {
${cand.body}
}
${base ? `namespace base {\n${base.body}\n}` : ''}

int main() {
  std::ios::sync_with_stdio(false);
  int n_cases = 0;
  if (!(std::cin >> n_cases)) { std::cout << "COMPILE_OK 0\\n"; return 0; }
  std::cin.get();

  std::cout << "COMPILE_OK " << n_cases << "\\n";

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
    double cand_ms = 0.0;
    double base_ms = -1.0;
    bool ok = true;
    std::string err;

    try {
${callBlock(sig, 'cand', 'result', 'cand_ms', true)}
    } catch (const std::exception& e) { ok = false; err = e.what(); }
      catch (...) { ok = false; err = "unknown C++ exception"; }

${
  base
    ? `    if (ok) {
      try {
        std::string ignored;
${callBlock(sig, 'base', 'ignored', 'base_ms', false)}
      } catch (...) { base_ms = -1.0; }
    }`
    : ''
}

    if (ok) {
      std::cout << "OK " << cand_ms << " " << base_ms << " "
                << escape_line(result) << " |STDOUT| " << escape_line(captured_out) << "\\n";
    } else {
      std::cout << "ERR " << escape_line(err) << "\\n";
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
      const s = String(value ?? '');
      parts.push(String(s.length));
      parts.push(s);
      return;
    }
    if (t === 'bool') {
      parts.push(value ? '1' : '0');
      return;
    }
    parts.push(String(value ?? 0));
  };
  params.forEach((p, i) => emit(p.type, args[i]));
  return parts.join('\n');
}
