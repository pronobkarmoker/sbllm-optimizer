# Demo 2 — no matching entry in the 13-pattern base, so the model has to reason
# rather than recall a retrieved pattern. Useful for showing the search doing real
# work instead of pattern lookup.
#
# Rebuilds the candidate prefix string from scratch on every character, which is
# repeated O(n^2) string work. Expected: SBLLM stops rebuilding the string and
# compares characters in place (or slices once at the end).

def longest_common_prefix(words):
    if not words:
        return ""
    prefix = ""
    shortest = min(words, key=len)
    for index in range(len(shortest)):
        candidate = ""
        for position in range(index + 1):
            candidate = candidate + shortest[position]
        for word in words:
            if not word.startswith(candidate):
                return prefix
        prefix = candidate
    return prefix
