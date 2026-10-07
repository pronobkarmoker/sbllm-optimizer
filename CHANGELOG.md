# Changelog

## 0.4.2

- **Compare view: original and optimized side by side, with syntactic and semantic similarity.** Opens automatically for a verified result, and from **Compare** in the insights panel (any candidate) or **SBLLM: Compare Best Result**.
  - Side-by-side code with syntax highlighting; removed / added / changed lines aligned and colour-coded.
  - *Syntactic similarity*: token similarity (comments ignored) and structural (AST) similarity — the same comparison after identifiers and literals are normalized, so a rename alone doesn't lower it — plus lines unchanged/changed/added/removed.
  - *Semantic similarity*, measured by execution: both versions run on every test input (search, held-out and stress); the share of inputs where return value, printed output and argument state are identical, with a per-input table of both outputs, both timings and the reason for any mismatch.
  - Static complexity estimate before → after (e.g. O(n^2) → O(n)), and the overall speedup.
- `npm run optimize` prints the same comparison.

## 0.4.1

- If every top candidate fails the held-out tests, the remaining candidates that passed the search tests are verified too — a slower but correct one was being thrown away.
- Why a candidate failed the held-out tests is now shown in the log and the insights panel; the panel no longer says "every candidate failed" when some passed the search tests.
- Test inputs outside the function's contract are also filtered using execution evidence: if a flat list works on the original, nested/dict/mixed lists for that argument are dropped.

## 0.4.0

Completes the project proposal's feature list and closes the remaining gaps to the paper's method.

**New**

- **Intelligent code analysis.** Python and C++ files are statically analyzed for inefficient code — nested loops (with an `O(n^k)` estimate), linear lookups/STL scans inside loops, loop-invariant recomputation, quadratic string/list building, `pop(0)` / front erases, sorting in loops, `std::endl` in loops, containers passed by value, exponential recursion without memoization, sorting to take a min/max. Shown as diagnostics with suggestions, an **⚡ Optimize** CodeLens on flagged functions, and a quick fix. New command **SBLLM: Analyze File for Performance Issues** and `npm run analyze`.
- **Pattern retrieval now follows Algorithm 1.** BM25 over the abstracted slow code and over the abstracted deleted/added statements (`d_s`/`d_f`) of each optimization pair, with the released code's scoring, retrieving one similar and one different pattern. Patterns are shown to the model as diffs, as in the reference implementation. Previously this was token-Jaccard over hand-written tags.
- **PIE-mined pattern bases.** `scripts/mine_patterns.py` builds a pattern file from a PIE training split; load it with `sbllmOptimizer.patternFile`.
- **Algorithm 2 population update.** `Sol ← RS ∪ NC` each iteration (the population used to grow without bound), seeded with a chain-of-thought initial population of `generationNumber` candidates instead of a single seed.
- **GO-COT prompt restructured to the paper's Fig. 3** — crossover / mutation / generation instructions, reasoning specification, input placeholder with measured times.
- **Verified results only.** The top 3 publicly-correct candidates are re-measured on the private tests; a result is offered for Apply only if it is correct there and at least `sbllmOptimizer.minSpeedup` (default 1.1x, the paper's OPT threshold) faster.
- **Insights panel:** live candidate list, original-vs-optimized time comparison, verified finalists (each appliable), the per-iteration search trace, and a Cancel button.
- **OpenAI / OpenAI-compatible provider** (OpenAI, LM Studio, vLLM, ...) — **SBLLM: Set OpenAI API Key**.
- **Optimization history** saved as JSON — **SBLLM: Show Optimization History**.
- New settings: `pythonPath`, `cppCompiler`, `patternFile`, `minSpeedup`, `openaiModel`, `openaiBaseUrl`, `analysis.*`. Interpreter/compiler/endpoint settings are ignored in untrusted workspaces.
- Test suite (`npm test`), including an end-to-end optimizer run against a scripted LLM.

**Fixes**

- A single candidate that called `sys.exit()`, crashed the interpreter or hung **aborted the whole optimization run**. It is now scored as incorrect and the search continues.
- A C++ candidate that threw an exception left `std::cout` pointing at a destroyed buffer, **losing every result in the batch**.
- C++ candidates (or file context) with a helper function above the target **failed to compile** — the harness picked the first function in the file instead of the target by name. Python had the same bug in its signature check.
- Python signatures with generic type hints (`dict[str, int]`) or defaults containing parentheses were mis-parsed, so a candidate that kept a type hint was rejected as a signature change.
- C++ `char` parameters were always read as `'\n'`; non-ASCII strings desynchronized the C++ input protocol (lengths are now UTF-8 bytes).
- Functions returning a set of strings failed against their own ground truth (per-process hash randomization); sets and non-string-keyed dicts are now serialized canonically and `PYTHONHASHSEED` is fixed.
- In-place mutation is now part of a function's observable behaviour (Python and C++), and the C++ timing loop gives every call a fresh copy of non-const reference arguments instead of re-running on already-mutated data.
- The stress input (the one large enough to show asymptotic speedups) always landed in the private split, so the search only ever timed tiny inputs. One stress input now goes to each split, and they run in their own batch so a very slow original can't take the regular cases down.
- The "best" result could be a candidate that **failed the public tests** (if it happened to pass the small private set), or one **slower than the original** — and Apply was enabled for it.
- **Apply could corrupt the file**: it reused the range captured when the run started, so applying twice (or after editing) replaced the wrong text. Apply now locates the function by its current text.
- **Cancel discarded everything**; it now verifies and reports the best candidate found so far.
- All top-level code above the function (e.g. `n = input()`, file writes, prints) ran on every evaluation. Only side-effect-free statements are kept as context now; C++ `main()` is stripped.
- A model reply with no usable code in the *seed* step aborted the run.
- Representative selection allocated a full edit-distance matrix per pair on the extension host thread; now O(min(n, m)) memory with cached abstractions.
- Test-input generation now honours cancellation and retries once on malformed JSON.

**Found by running against a real local model (qwen2.5-coder:1.5b via Ollama)**

- A small model can fall into a repetition loop and stream forever (observed: 9,000+ tokens for a ~300-token reply), hanging the run. Ollama output is now capped (`num_predict`), and a test-input reply cut off by the cap keeps its complete entries.
- Generated test inputs outside the function's real contract are dropped: a single list of lists, list of dicts or mixed-type list made every correct set- or sort-based rewrite fail verification. Inputs that disagree with a clear majority shape, or that contain nested/dict/None/mixed lists when flat lists are just as common, are dropped up front; and after the original has run, if a flat list (including the generated stress inputs) works on it, structured lists for that argument are dropped too. A function that really needs nested lists fails on flat ones, so it is unaffected.
- C++ crashes are reported as e.g. "segmentation fault" instead of a raw Windows exit code.
- Replies stuck in a repetition loop (the same sentence ~100 times, never reaching the code) are now detected while streaming and stopped within a few hundred tokens instead of running to the cap — minutes saved per occurrence on a CPU-only model. Ollama requests also use a mild repeat penalty. Such a reply counts as an unusable sample, not as a model/connection failure.
- **Candidate repair.** A candidate that defines the right function under a different name (often copied from an incorrect version in the prompt) is renamed back, and Python candidates that use well-known standard-library names (`lru_cache`, `Counter`, `deque`, `bisect_left`, `heappush`, ...) without importing them get the import added. Both used to throw away otherwise-correct candidates; the repaired code is still verified by the test oracle like any other.
- New command **SBLLM: Apply Best Result**, and a VS Code integration test suite (`npm run test:vscode`) that drives the real extension in a separate VS Code instance.
- The OpenAI default model is now `gpt-5-mini` (GPT-4o has been retired from ChatGPT and announced for API retirement).

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
