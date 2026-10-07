# Demo 3 — a tour of the inefficiency patterns SBLLM's static analysis flags.
# Open this file with the extension running: each function gets diagnostics and an
# "⚡ SBLLM: ... — Optimize" CodeLens. Click it to run the search on that function.

from functools import lru_cache


def count_common(first, second):
    # Linear `in` against a list, inside a loop -> O(n*m).
    seen = []
    for x in second:
        seen.append(x)
    total = 0
    for x in first:
        if x in seen:
            total += 1
    return total


def normalize(values):
    # max() of an unchanging list recomputed on every iteration -> O(n^2).
    result = []
    for v in values:
        result.append(v / max(values))
    return result


def join_words(words):
    # Quadratic string building.
    text = ""
    for w in words:
        text += w + " "
    return text


def drain(queue_items):
    # list.pop(0) shifts every element -> O(n^2) overall.
    items = list(queue_items)
    order = []
    while items:
        order.append(items.pop(0))
    return order


def stairs(n):
    # Two self-calls, no memoization -> exponential.
    if n <= 1:
        return 1
    return stairs(n - 1) + stairs(n - 2)


def smallest(values):
    # Sorting to take one end is O(n log n); min() is O(n).
    return sorted(values)[0]


@lru_cache(maxsize=None)
def stairs_memo(n):
    # Already memoized — not flagged.
    if n <= 1:
        return 1
    return stairs_memo(n - 1) + stairs_memo(n - 2)
