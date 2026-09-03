# Changelog

## 0.3.0

**C++ support**, covering the second language the paper evaluates on (994 PIE test samples alongside Python's 986).

- Candidates are compiled with `-std=c++17 -O3`, the paper's own settings. The candidate and the original are compiled into a single binary, each in its own namespace, so both are timed in the same process — the same paired-baseline measurement used for Python.
- A curated 12-pattern C++ base, every entry verified to compile and to be behaviour-preserving.
- C++ function detection by brace matching, aware of strings and comments so a `"}"` inside a literal cannot truncate the selection.
- The search loop, fitness evaluation and test oracle are now language-independent, talking only to a `LanguageAdapter`.
- Supported signatures: integer, floating-point, `bool`, `char`, `std::string`, and `std::vector` of those (one level of nesting). Anything else is reported clearly rather than guessed at.

**Fixes**

- **C++ timings were meaningless without this.** At `-O3` a call whose result is discarded in a timing loop is dead code and GCC deletes it outright, so an O(n²) scan over 4000 elements measured 0.0006 ms. Timed calls now feed a volatile sink behind a compiler barrier; the same scan measures 6.34 ms.
- **Ollama requests now stream.** A non-streaming request sends no response headers until generation completes, so Node's `fetch` aborted a healthy but slow local model with `UND_ERR_HEADERS_TIMEOUT`; and a non-streaming `node:http` request inside the VS Code extension host returned HTTP 200 with a real content-length while delivering no body at all. Responses are read incrementally as NDJSON, over `fetch` with `node:http` as a fallback.
- **Fenced code blocks inside a JSON reply no longer corrupt parsing.** A ``` fence found anywhere was being stripped, including one inside the `code` value, which left the bare language tag as the candidate's first line. This affected Python too.
- **Model replies with raw newlines inside JSON strings are repaired** instead of being discarded — a common shape for small models emitting multi-line code.
- New **SBLLM: Diagnose Connection** command, which probes the configured Ollama host over several transports and reports what it finds.

## 0.2.1

- Documentation only. Expanded the author section so each role and organisation renders on its own line — Markdown collapses single newlines, so the previous version ran them together into one paragraph.

## 0.2.0

Fidelity and correctness work, from a component-by-component audit against the paper.

- **Multiple candidates per iteration.** The search now samples several candidates each iteration (`generation_number`, the paper's setting, default 4) instead of one. Generating a single candidate had reduced the evolutionary search to a linear chain: the pool never grew beyond `Ns`, so representative selection had nothing to choose between and crossover had no distinct methods to combine. Configurable via `sbllmOptimizer.generationNumber`.
- **Algorithm 1 now follows the paper.** Representative selection uses `acc == 1` for the correct group, as the paper's pseudocode states; the authors' released code uses `acc > 0`, which contradicts it.
- **Optimization patterns are self-contained functions.** They were previously bare fragments with undefined variables, and models copied those names verbatim into generated code — a measured 19% of candidates in one run failed with `NameError: name 'target' is not defined`. All 13 patterns are now verified by AST analysis to have no free names, and by execution to be behaviour-preserving.
- **Test-input synthesis respects the intended contract.** The oracle could invent inputs (e.g. nested lists) outside what a function was written for, which rules out entire classes of valid optimization and made correct candidates look wrong. It now infers and holds to the intended element type.
- **More accurate speedup measurement.** The baseline is re-timed in the same subprocess as each candidate, removing a directional bias that made identical code report anywhere from 0.26x to 1.1x.
- **Correct enclosing-function detection.** Indentation is now tracked when scanning for the enclosing `def`, fixing cases where the cursor bound to a preceding or nested function instead of the real one.

## 0.1.0

Initial release.

- **Optimize Selected Code** — right-click a Python selection, or place your cursor inside a function to auto-expand to the enclosing `def` block.
- **Search-based iterative refinement** — an evolutionary loop (Algorithm 2 from the SBLLM paper) selects representative candidates by fitness, retrieves optimization patterns, and re-prompts until it converges or hits an iteration budget.
- **Execution-based correctness verification** — every candidate is run and checked against the original's behavior (return value and printed output) via a differential test oracle, split into public/private test sets to guard against overfitting during the search.
- **Adaptive optimization pattern retrieval** — a curated pattern base steers the model toward proven techniques (set membership, memoization, list comprehensions, and more).
- **GO-COT prompting** — candidates are generated by combining what past attempts got right (crossover) with unexploited patterns (mutation).
- **Side-by-side diff** via VS Code's native diff editor.
- **Optimization Insights panel** — live progress, reasoning, speedup, and full search history.
- **Refine Further** — continue searching without re-synthesizing test cases.
- **Local or cloud LLM** — Ollama (fully offline) or Gemini.
