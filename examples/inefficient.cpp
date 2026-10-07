// C++ demo — inefficiency patterns SBLLM's static analysis flags. Each function gets
// diagnostics and an "⚡ SBLLM: ... — Optimize" CodeLens. Candidates are benchmarked with
// -std=c++17 -O3, so only improvements the compiler can't make on its own will show up.

#include <algorithm>
#include <string>
#include <vector>

// std::find inside a loop -> O(n*m); `allowed` is also copied on every call.
int count_allowed(std::vector<int> values, std::vector<int> allowed) {
    int total = 0;
    for (int v : values) {
        if (std::find(allowed.begin(), allowed.end(), v) != allowed.end()) total++;
    }
    return total;
}

// Erasing from the front of a vector shifts every element -> O(n^2).
long long drain_sum(std::vector<int> items) {
    long long sum = 0;
    while (!items.empty()) {
        sum += items.front();
        items.erase(items.begin());
    }
    return sum;
}

// s = s + piece copies the whole string every iteration.
std::string repeat_word(const std::string& word, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) {
        out = out + word;
    }
    return out;
}

// Exponential recursion.
long long ways(int n) {
    if (n <= 1) return 1;
    return ways(n - 1) + ways(n - 2);
}
