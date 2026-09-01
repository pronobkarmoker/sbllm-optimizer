# Demo 1 — the classic O(n^2) -> O(n) rewrite.
# Compares every pair of elements to find a repeat. Correct, but quadratic.
# Expected: SBLLM replaces the nested loop with a single pass using a set.

def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False
