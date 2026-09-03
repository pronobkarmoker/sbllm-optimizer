// C++ demo — the same quadratic duplicate check, compiled with -std=c++17 -O3
// (the paper's own settings). Expected: SBLLM replaces the nested loop with a
// single pass using an unordered_set.

#include <vector>

bool has_duplicate(std::vector<int> numbers) {
    for (size_t i = 0; i < numbers.size(); ++i) {
        for (size_t j = 0; j < numbers.size(); ++j) {
            if (i != j && numbers[i] == numbers[j]) return true;
        }
    }
    return false;
}
