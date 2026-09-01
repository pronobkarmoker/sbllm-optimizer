import type { Pattern } from '../patternBase.js';

/**
 * The curated pattern base from ARCHITECTURE.md §4, embedded as a TS module rather than read from
 * a JSON asset at runtime — this makes it bundle-safe: esbuild inlines it into the extension's
 * single-file output with no filesystem path to resolve at extension-load time.
 */
export const pythonPatterns: Pattern[] = [
  {
    id: 'set-membership',
    tags: ['membership', 'in', 'list', 'set', 'lookup', 'contains'],
    description: 'Checking membership repeatedly against a list is O(n) per check; a set gives O(1) average.',
    slow: 'if x in some_list:',
    fast: 'some_set = set(some_list)\nif x in some_set:',
  },
  {
    id: 'nested-loop-duplicate',
    tags: ['nested', 'loop', 'duplicate', 'pair', 'compare', 'quadratic'],
    description: 'A nested loop comparing every pair is O(n^2); a set/dict pass to track seen items is O(n).',
    slow: 'for i in range(len(a)):\n    for j in range(len(a)):\n        if i != j and a[i] == a[j]:\n            return True',
    fast: 'seen = set()\nfor x in a:\n    if x in seen:\n        return True\n    seen.add(x)',
  },
  {
    id: 'list-comprehension',
    tags: ['append', 'loop', 'list', 'comprehension', 'build'],
    description: 'Building a list with repeated .append() in a loop is slower than a list comprehension.',
    slow: 'result = []\nfor x in items:\n    result.append(f(x))',
    fast: 'result = [f(x) for x in items]',
  },
  {
    id: 'generator-single-pass',
    tags: ['generator', 'memory', 'iterate', 'once', 'sum', 'any', 'all'],
    description:
      'When a sequence is only iterated once (e.g. into sum/any/all), a generator avoids materializing the full list.',
    slow: 'total = sum([f(x) for x in items])',
    fast: 'total = sum(f(x) for x in items)',
  },
  {
    id: 'builtin-aggregate',
    tags: ['sum', 'max', 'min', 'manual', 'loop', 'aggregate'],
    description: 'Manual accumulation loops for sum/max/min are slower than the built-in, which is implemented in C.',
    slow: 'total = 0\nfor x in items:\n    total += x',
    fast: 'total = sum(items)',
  },
  {
    id: 'string-join',
    tags: ['string', 'concatenation', 'plus', 'loop', 'join'],
    description: "Repeated string += in a loop is O(n^2) due to string immutability; str.join is O(n).",
    slow: "s = ''\nfor part in parts:\n    s += part",
    fast: "s = ''.join(parts)",
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
      'Checking primality by trial division for every number up to n is much slower than a sieve for finding all primes up to n.',
    slow: 'def is_prime(x):\n    for i in range(2, x):\n        if x % i == 0:\n            return False\n    return True',
    fast:
      'def primes_up_to(n):\n    sieve = [True] * (n + 1)\n    sieve[0] = sieve[1] = False\n    for p in range(2, int(n ** 0.5) + 1):\n        if sieve[p]:\n            for i in range(p * p, n + 1, p):\n                sieve[i] = False\n    return sieve',
  },
  {
    id: 'hoist-loop-invariant',
    tags: ['loop', 'invariant', 'recompute', 'hoist', 'constant'],
    description: "Recomputing a value that doesn't change every loop iteration wastes work; compute it once outside the loop.",
    slow: 'for x in items:\n    y = expensive_constant_computation()\n    use(x, y)',
    fast: 'y = expensive_constant_computation()\nfor x in items:\n    use(x, y)',
  },
  {
    id: 'counter-for-frequency',
    tags: ['count', 'frequency', 'dict', 'counter', 'histogram'],
    description:
      'Manually counting occurrences with a dict and get/setdefault is more verbose and slower than collections.Counter.',
    slow: 'counts = {}\nfor x in items:\n    counts[x] = counts.get(x, 0) + 1',
    fast: 'from collections import Counter\ncounts = Counter(items)',
  },
  {
    id: 'sort-key-function',
    tags: ['sort', 'comparator', 'key', 'cmp'],
    description: 'A custom comparator function forces a slower sort path; a key function lets sort use the fast Timsort directly.',
    slow: 'import functools\nitems.sort(key=functools.cmp_to_key(lambda a, b: a.value - b.value))',
    fast: 'items.sort(key=lambda a: a.value)',
  },
  {
    id: 'multi-way-intersection',
    tags: ['triple', 'nested', 'loop', 'intersection', 'common', 'three', 'lists', 'equal', 'shared', 'all'],
    description:
      'A triple-nested loop checking that all three values are equal to each other (a==b and b==c) is O(n^3), ' +
      'and easy to get subtly wrong by checking membership against each list separately instead of requiring the ' +
      'SAME value in all three. set(a) & set(b) & set(c) computes the true intersection in one step and is O(n).',
    slow:
      'for a in list1:\n    for b in list2:\n        for c in list3:\n            if a == b and b == c:\n                print(a)',
    fast: 'common = set(list1) & set(list2) & set(list3)\nfor x in common:\n    print(x)',
  },
  {
    id: 'two-pointer-vs-nested',
    tags: ['two', 'pointer', 'sorted', 'pair', 'target', 'sum', 'nested'],
    description: 'Finding a pair meeting a condition in a sorted sequence with nested loops is O(n^2); a two-pointer scan is O(n).',
    slow: 'for i in range(len(a)):\n    for j in range(i + 1, len(a)):\n        if a[i] + a[j] == target:\n            return (i, j)',
    fast:
      'lo, hi = 0, len(a) - 1\nwhile lo < hi:\n    s = a[lo] + a[hi]\n    if s == target:\n        return (lo, hi)\n    elif s < target:\n        lo += 1\n    else:\n        hi -= 1',
  },
];
