import type { Pattern } from '../patternBase.js';

/**
 * The curated pattern base from ARCHITECTURE.md §4, embedded as a TS module rather than read from
 * a JSON asset at runtime — this makes it bundle-safe: esbuild inlines it into the extension's
 * single-file output with no filesystem path to resolve at extension-load time.
 *
 * Every `slow`/`fast` pair is a COMPLETE, self-contained function, deliberately. They were
 * originally bare fragments (`if x in some_list:`), which left free variables like `target`
 * undefined — and a measured 19% of generated candidates in one run failed with
 * `NameError: name 'target' is not defined` because the model lifted such a name verbatim into a
 * function that had no such variable. Self-contained functions fix this structurally rather than
 * by adding more prompt warnings: every identifier is now either a parameter of the example or
 * bound inside it, so there is nothing danging to copy. It also makes the system prompt's rule
 * ("patterns use a DIFFERENT example function with its own name and parameters — never adopt
 * them") actually coherent, and lets the arity guard in differential.ts catch a copied signature.
 */
export const pythonPatterns: Pattern[] = [
  {
    id: 'set-membership',
    tags: ['membership', 'in', 'list', 'set', 'lookup', 'contains'],
    description: 'Checking membership repeatedly against a list is O(n) per check; a set gives O(1) average.',
    slow: 'def count_allowed(values, allowed):\n    total = 0\n    for value in values:\n        if value in allowed:\n            total += 1\n    return total',
    fast: 'def count_allowed(values, allowed):\n    allowed_set = set(allowed)\n    total = 0\n    for value in values:\n        if value in allowed_set:\n            total += 1\n    return total',
  },
  {
    id: 'nested-loop-duplicate',
    tags: ['nested', 'loop', 'duplicate', 'pair', 'compare', 'quadratic'],
    description: 'A nested loop comparing every pair is O(n^2); a single pass with a set to track seen items is O(n).',
    slow: 'def contains_repeat(values):\n    for i in range(len(values)):\n        for j in range(len(values)):\n            if i != j and values[i] == values[j]:\n                return True\n    return False',
    fast: 'def contains_repeat(values):\n    seen = set()\n    for value in values:\n        if value in seen:\n            return True\n        seen.add(value)\n    return False',
  },
  {
    id: 'list-comprehension',
    tags: ['append', 'loop', 'list', 'comprehension', 'build'],
    description: 'Building a list with repeated .append() in a loop is slower than a list comprehension.',
    slow: 'def squares(numbers):\n    result = []\n    for number in numbers:\n        result.append(number * number)\n    return result',
    fast: 'def squares(numbers):\n    return [number * number for number in numbers]',
  },
  {
    id: 'generator-single-pass',
    tags: ['generator', 'memory', 'iterate', 'once', 'sum', 'any', 'all'],
    description:
      'When a sequence is only iterated once (e.g. into sum/any/all), a generator avoids materializing the full list.',
    slow: 'def total_length(words):\n    return sum([len(word) for word in words])',
    fast: 'def total_length(words):\n    return sum(len(word) for word in words)',
  },
  {
    id: 'builtin-aggregate',
    tags: ['sum', 'max', 'min', 'manual', 'loop', 'aggregate'],
    description: 'Manual accumulation loops for sum/max/min are slower than the built-in, which is implemented in C.',
    slow: 'def total(numbers):\n    result = 0\n    for number in numbers:\n        result += number\n    return result',
    fast: 'def total(numbers):\n    return sum(numbers)',
  },
  {
    id: 'string-join',
    tags: ['string', 'concatenation', 'plus', 'loop', 'join'],
    description: "Repeated string += in a loop is O(n^2) due to string immutability; str.join is O(n).",
    slow: "def join_parts(parts):\n    text = ''\n    for part in parts:\n        text += part\n    return text",
    fast: "def join_parts(parts):\n    return ''.join(parts)",
  },
  {
    id: 'memoization',
    tags: ['recursion', 'memoize', 'cache', 'fibonacci', 'repeated', 'compute'],
    description: 'Recursive functions with overlapping subproblems recompute the same result repeatedly; caching avoids that.',
    slow: 'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)',
    fast:
      'from functools import lru_cache\n\n@lru_cache(maxsize=None)\ndef fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)',
  },
  {
    id: 'sieve-vs-trial-division',
    tags: ['prime', 'primality', 'sieve', 'eratosthenes', 'trial', 'division'],
    description:
      'Testing each number for primality by trial division is far slower than sieving once when many numbers are tested.',
    slow:
      'def count_primes(limit):\n    count = 0\n    for value in range(2, limit):\n        is_prime = True\n        for divisor in range(2, value):\n            if value % divisor == 0:\n                is_prime = False\n                break\n        if is_prime:\n            count += 1\n    return count',
    fast:
      'def count_primes(limit):\n    if limit < 3:\n        return 0\n    sieve = [True] * limit\n    sieve[0] = sieve[1] = False\n    for p in range(2, int(limit ** 0.5) + 1):\n        if sieve[p]:\n            for multiple in range(p * p, limit, p):\n                sieve[multiple] = False\n    return sum(sieve)',
  },
  {
    id: 'hoist-loop-invariant',
    tags: ['loop', 'invariant', 'recompute', 'hoist', 'constant'],
    description: "Recomputing a value that doesn't change every loop iteration wastes work; compute it once outside the loop.",
    slow:
      'def normalize(values, factor):\n    result = []\n    for value in values:\n        scale = max(abs(factor), 1)\n        result.append(value / scale)\n    return result',
    fast:
      'def normalize(values, factor):\n    scale = max(abs(factor), 1)\n    result = []\n    for value in values:\n        result.append(value / scale)\n    return result',
  },
  {
    id: 'counter-for-frequency',
    tags: ['count', 'frequency', 'dict', 'counter', 'histogram'],
    description:
      'Manually counting occurrences with a dict and get/setdefault is more verbose and slower than collections.Counter.',
    slow: 'def frequencies(items):\n    counts = {}\n    for item in items:\n        counts[item] = counts.get(item, 0) + 1\n    return counts',
    fast: 'from collections import Counter\n\ndef frequencies(items):\n    return dict(Counter(items))',
  },
  {
    id: 'sort-key-function',
    tags: ['sort', 'comparator', 'key', 'cmp'],
    description: 'A custom comparator function forces a slower sort path; a key function lets sort use the fast Timsort directly.',
    slow:
      'import functools\n\ndef sort_by_length(words):\n    return sorted(words, key=functools.cmp_to_key(lambda a, b: len(a) - len(b)))',
    fast: 'def sort_by_length(words):\n    return sorted(words, key=len)',
  },
  {
    id: 'multi-way-intersection',
    tags: ['triple', 'nested', 'loop', 'intersection', 'common', 'three', 'lists', 'equal', 'shared', 'all'],
    description:
      'A triple-nested loop checking that all three values are equal to each other (a==b and b==c) is O(n^3), ' +
      'and easy to get subtly wrong by checking membership against each list separately instead of requiring the ' +
      'SAME value in all three. set(a) & set(b) & set(c) computes the true intersection in one step and is O(n).',
    slow:
      'def common_values(first, second, third):\n    result = []\n    for a in first:\n        for b in second:\n            for c in third:\n                if a == b and b == c and a not in result:\n                    result.append(a)\n    return result',
    fast: 'def common_values(first, second, third):\n    return list(set(first) & set(second) & set(third))',
  },
  {
    id: 'two-pointer-vs-nested',
    tags: ['two', 'pointer', 'sorted', 'pair', 'sum', 'nested'],
    description: 'Finding a pair meeting a condition in a sorted sequence with nested loops is O(n^2); a two-pointer scan is O(n).',
    slow:
      'def has_pair_with_sum(sorted_values, wanted):\n    for i in range(len(sorted_values)):\n        for j in range(i + 1, len(sorted_values)):\n            if sorted_values[i] + sorted_values[j] == wanted:\n                return True\n    return False',
    fast:
      'def has_pair_with_sum(sorted_values, wanted):\n    low, high = 0, len(sorted_values) - 1\n    while low < high:\n        pair_sum = sorted_values[low] + sorted_values[high]\n        if pair_sum == wanted:\n            return True\n        if pair_sum < wanted:\n            low += 1\n        else:\n            high -= 1\n    return False',
  },
];
