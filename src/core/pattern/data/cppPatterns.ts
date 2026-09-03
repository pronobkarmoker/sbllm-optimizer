import type { Pattern } from '../patternBase.js';

/**
 * C++ counterpart to pythonPatterns. The paper mines its pattern corpus from PIE's C++ training
 * split (77,967 samples); this is the same curated stand-in used for Python, scoped to techniques
 * that actually matter under -O3 — the compiler already handles the trivial ones, so patterns here
 * target algorithmic and data-structure changes it cannot make for you.
 *
 * As with Python, every slow/fast pair is a complete, self-contained function with no undefined
 * names, so a model copying from one cannot paste a dangling identifier into its answer.
 */
export const cppPatterns: Pattern[] = [
  {
    id: 'cpp-set-membership',
    tags: ['membership', 'find', 'vector', 'set', 'lookup', 'contains', 'linear'],
    description:
      'Repeated std::find over a vector is O(n) per lookup. Building an unordered_set once makes each lookup O(1) average.',
    slow: 'int count_allowed(std::vector<int> values, std::vector<int> allowed) {\n    int total = 0;\n    for (int v : values) {\n        if (std::find(allowed.begin(), allowed.end(), v) != allowed.end()) total++;\n    }\n    return total;\n}',
    fast: 'int count_allowed(std::vector<int> values, std::vector<int> allowed) {\n    std::unordered_set<int> lookup(allowed.begin(), allowed.end());\n    int total = 0;\n    for (int v : values) {\n        if (lookup.count(v)) total++;\n    }\n    return total;\n}',
  },
  {
    id: 'cpp-nested-loop-duplicate',
    tags: ['nested', 'loop', 'duplicate', 'pair', 'quadratic', 'compare'],
    description: 'Comparing every pair is O(n^2); one pass with a hash set is O(n).',
    slow: 'bool contains_repeat(std::vector<int> values) {\n    for (size_t i = 0; i < values.size(); ++i) {\n        for (size_t j = 0; j < values.size(); ++j) {\n            if (i != j && values[i] == values[j]) return true;\n        }\n    }\n    return false;\n}',
    fast: 'bool contains_repeat(std::vector<int> values) {\n    std::unordered_set<int> seen;\n    for (int v : values) {\n        if (!seen.insert(v).second) return true;\n    }\n    return false;\n}',
  },
  {
    id: 'cpp-reserve-capacity',
    tags: ['push_back', 'reserve', 'vector', 'reallocation', 'capacity', 'grow'],
    description:
      'push_back into a vector without reserving reallocates and copies repeatedly as it grows; reserve() once when the size is known avoids that.',
    slow: 'std::vector<int> doubled(std::vector<int> values) {\n    std::vector<int> out;\n    for (int v : values) out.push_back(v * 2);\n    return out;\n}',
    fast: 'std::vector<int> doubled(std::vector<int> values) {\n    std::vector<int> out;\n    out.reserve(values.size());\n    for (int v : values) out.push_back(v * 2);\n    return out;\n}',
  },
  {
    id: 'cpp-pass-by-reference',
    tags: ['copy', 'parameter', 'reference', 'const', 'pass', 'value'],
    description:
      'Taking a large container by value copies it on every call. Taking it by const reference removes the copy without changing behaviour.',
    slow: 'long long total(std::vector<int> values) {\n    long long sum = 0;\n    for (int v : values) sum += v;\n    return sum;\n}',
    fast: 'long long total(const std::vector<int>& values) {\n    long long sum = 0;\n    for (int v : values) sum += v;\n    return sum;\n}',
  },
  {
    id: 'cpp-string-append',
    tags: ['string', 'concatenation', 'append', 'operator', 'loop', 'temporary'],
    description:
      'Building a string with s = s + piece creates a fresh temporary each iteration, making it O(n^2). Appending in place is O(n).',
    slow: 'std::string join_parts(std::vector<std::string> parts) {\n    std::string out;\n    for (size_t i = 0; i < parts.size(); ++i) {\n        out = out + parts[i];\n    }\n    return out;\n}',
    fast: 'std::string join_parts(std::vector<std::string> parts) {\n    size_t total = 0;\n    for (const std::string& p : parts) total += p.size();\n    std::string out;\n    out.reserve(total);\n    for (const std::string& p : parts) out += p;\n    return out;\n}',
  },
  {
    id: 'cpp-sort-then-scan',
    tags: ['sort', 'scan', 'adjacent', 'unique', 'duplicate', 'quadratic'],
    description:
      'Counting distinct values by comparing every pair is O(n^2). Sorting once and scanning adjacent elements is O(n log n).',
    slow: 'int count_distinct(std::vector<int> values) {\n    int distinct = 0;\n    for (size_t i = 0; i < values.size(); ++i) {\n        bool seen_before = false;\n        for (size_t j = 0; j < i; ++j) {\n            if (values[j] == values[i]) { seen_before = true; break; }\n        }\n        if (!seen_before) distinct++;\n    }\n    return distinct;\n}',
    fast: 'int count_distinct(std::vector<int> values) {\n    std::sort(values.begin(), values.end());\n    return (int)(std::unique(values.begin(), values.end()) - values.begin());\n}',
  },
  {
    id: 'cpp-memoized-recursion',
    tags: ['recursion', 'memoize', 'cache', 'fibonacci', 'exponential', 'overlapping'],
    description: 'Recursion with overlapping subproblems recomputes the same values exponentially; caching makes it linear.',
    slow: 'long long fib(int n) {\n    if (n < 2) return n;\n    return fib(n - 1) + fib(n - 2);\n}',
    fast: 'long long fib(int n) {\n    if (n < 2) return n;\n    std::vector<long long> memo(n + 1, 0);\n    memo[1] = 1;\n    for (int i = 2; i <= n; ++i) memo[i] = memo[i - 1] + memo[i - 2];\n    return memo[n];\n}',
  },
  {
    id: 'cpp-hoist-loop-invariant',
    tags: ['loop', 'invariant', 'hoist', 'recompute', 'size', 'call'],
    description:
      'Recomputing an unchanging value inside a loop wastes work, especially when the compiler cannot prove the call is pure.',
    slow: 'std::vector<double> normalize(std::vector<double> values, double factor) {\n    std::vector<double> out;\n    out.reserve(values.size());\n    for (size_t i = 0; i < values.size(); ++i) {\n        double scale = std::sqrt(std::abs(factor) + 1.0);\n        out.push_back(values[i] / scale);\n    }\n    return out;\n}',
    fast: 'std::vector<double> normalize(std::vector<double> values, double factor) {\n    double scale = std::sqrt(std::abs(factor) + 1.0);\n    std::vector<double> out;\n    out.reserve(values.size());\n    for (size_t i = 0; i < values.size(); ++i) {\n        out.push_back(values[i] / scale);\n    }\n    return out;\n}',
  },
  {
    id: 'cpp-two-pointer',
    tags: ['two', 'pointer', 'sorted', 'pair', 'sum', 'nested', 'search'],
    description: 'Searching a sorted sequence for a pair with nested loops is O(n^2); a two-pointer scan is O(n).',
    slow: 'bool has_pair_with_sum(std::vector<int> sorted_values, int wanted) {\n    for (size_t i = 0; i < sorted_values.size(); ++i) {\n        for (size_t j = i + 1; j < sorted_values.size(); ++j) {\n            if (sorted_values[i] + sorted_values[j] == wanted) return true;\n        }\n    }\n    return false;\n}',
    fast: 'bool has_pair_with_sum(std::vector<int> sorted_values, int wanted) {\n    if (sorted_values.empty()) return false;\n    size_t low = 0, high = sorted_values.size() - 1;\n    while (low < high) {\n        int s = sorted_values[low] + sorted_values[high];\n        if (s == wanted) return true;\n        if (s < wanted) ++low; else --high;\n    }\n    return false;\n}',
  },
  {
    id: 'cpp-prefix-sums',
    tags: ['range', 'sum', 'repeated', 'prefix', 'cumulative', 'query'],
    description:
      'Recomputing a range sum for every query is O(n) per query; a prefix-sum array answers each query in O(1) after one O(n) pass.',
    slow: 'long long total_of_ranges(std::vector<int> values, int window) {\n    long long acc = 0;\n    for (size_t start = 0; start + window <= values.size(); ++start) {\n        for (int k = 0; k < window; ++k) acc += values[start + k];\n    }\n    return acc;\n}',
    fast: 'long long total_of_ranges(std::vector<int> values, int window) {\n    std::vector<long long> prefix(values.size() + 1, 0);\n    for (size_t i = 0; i < values.size(); ++i) prefix[i + 1] = prefix[i] + values[i];\n    long long acc = 0;\n    for (size_t start = 0; start + window <= values.size(); ++start) {\n        acc += prefix[start + window] - prefix[start];\n    }\n    return acc;\n}',
  },
  {
    id: 'cpp-endl-flush',
    tags: ['endl', 'cout', 'flush', 'output', 'newline', 'io'],
    description:
      'std::endl flushes the stream on every use, which is far slower than emitting a newline character when writing many lines.',
    slow: 'void print_all(std::vector<int> values) {\n    for (int v : values) std::cout << v << std::endl;\n}',
    fast: "void print_all(std::vector<int> values) {\n    for (int v : values) std::cout << v << '\\n';\n}",
  },
  {
    id: 'cpp-emplace-back',
    tags: ['emplace', 'push_back', 'construct', 'temporary', 'move', 'copy'],
    description:
      'push_back with a freshly constructed value builds a temporary and then copies or moves it; emplace_back constructs in place.',
    slow: 'std::vector<std::string> label_all(std::vector<int> values) {\n    std::vector<std::string> out;\n    out.reserve(values.size());\n    for (int v : values) out.push_back(std::string("id-") + std::to_string(v));\n    return out;\n}',
    fast: 'std::vector<std::string> label_all(std::vector<int> values) {\n    std::vector<std::string> out;\n    out.reserve(values.size());\n    for (int v : values) out.emplace_back("id-" + std::to_string(v));\n    return out;\n}',
  },
];
