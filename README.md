# SBLLM Optimizer

A VS Code extension that optimizes **Python and C++** code using search-based LLM techniques — it generates multiple candidate optimizations, verifies each one by actually running it, and iteratively refines toward a faster, correct solution.

Based on [*Search-Based LLMs for Code Optimization*](https://arxiv.org/abs/2408.12159) (Gao et al., ICSE'25), adapted from an offline research pipeline into an interactive editor tool.

## What it does

Most LLM-based code optimizers ask a model to rewrite your code once and hope for the best. SBLLM Optimizer instead treats optimization as a **search problem**: it seeds a candidate, executes it against a differential test oracle built from your original function, retrieves relevant optimization patterns, and uses that feedback to generate progressively better candidates — the same evolutionary loop the paper describes, running against your own code instead of a fixed benchmark dataset.

```
def has_duplicate(numbers):
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j and numbers[i] == numbers[j]:
                return True
    return False
```

becomes

```
def has_duplicate(numbers):
    seen = set()
    for num in numbers:
        if num in seen:
            return True
        seen.add(num)
    return False
```

Verified correct against held-out test cases. On this example the measured speedup is typically **300–380x**, though the figure is input-dependent by nature: the gap between O(n²) and O(n) grows with the size of the synthesized test inputs, so treat it as illustrative rather than a benchmark score.

The same works for C++, compiled with `-std=c++17 -O3` (the paper's own settings) — the equivalent nested-loop rewrite measures around **20x** there, since an optimizing compiler already removes much of the overhead a Python interpreter cannot.

## Features

- **Intelligent code analysis** — open a Python or C++ file and SBLLM statically flags inefficient code: nested loops (with an `O(n^k)` estimate), linear lookups or STL scans inside loops, loop-invariant recomputation, quadratic string/list building, `pop(0)`/front erases, sorting inside loops, `std::endl` in loops, containers passed by value, and exponential recursion without memoization. Findings appear as diagnostics with a suggested fix, plus an **⚡ Optimize** CodeLens above each flagged function and a quick fix on every finding.
- **Python and C++** — both languages the paper evaluates on; C++ is compiled with the paper's `-std=c++17 -O3`.
- **Execution-based evaluation** — every candidate is actually run against a differential test oracle built from your original function, and must match its return value, printed output *and* its effect on mutable arguments. The original is re-timed in the same process for every comparison, so speedups aren't skewed by system drift.
- **Search-based iterative refinement** — the paper's evolutionary loop (Algorithm 2): an initial chain-of-thought population, representative-sample selection by fitness (Algorithm 1), `Sol ← RS ∪ NC`, and its convergence check.
- **Adaptive optimization pattern retrieval** — BM25 over the abstracted code and the abstracted *deleted/added statements* of each optimization pair, retrieving one **similar** pattern (to fix errors) and one **different** pattern (an unexploited technique), as in the paper's Algorithm 1. Ships with curated patterns and can load a pattern base mined from PIE.
- **Genetic-operator-inspired prompting (GO-COT)** — explicit crossover / mutation / generation steps with a fixed reasoning specification.
- **Verified results only** — the top candidates are re-measured on held-out private tests; only a candidate that is correct there *and* at least 10% faster (the paper's OPT threshold) is offered for Apply.
- **Compare view** — original and optimized code side by side (syntax-highlighted, changed lines aligned), with *syntactic similarity* (token and AST-structural similarity, lines changed) and *semantic similarity* measured by execution: how many test inputs both versions handle identically, with a per-input table of outputs and timings, plus the complexity before → after.
- **Optimization Insights panel** — live candidate list, an original-vs-optimized time comparison, verified finalists, the per-iteration search trace (which samples and patterns were used), the model's reasoning, and Apply / Refine / Diff / Cancel.
- **Cancel any time** — cancelling keeps and verifies everything found so far.
- **History** — every run is saved (JSON, in extension storage) and can be reviewed and re-diffed later.
- **Local or cloud LLMs** — [Ollama](https://ollama.com) (fully offline), Gemini, or OpenAI / any OpenAI-compatible server (LM Studio, vLLM, ...). API keys live in VS Code's `SecretStorage`.

## How it works

```
 analyze ─▶ seed population (CoT) ─▶ ┌─────────── iterate (Algorithm 2) ───────────┐ ─▶ verify top-k ─▶ apply
 (static)   scored on public tests   │ select RS (Alg. 1) ─▶ retrieve similar and   │    on private
                                     │ different patterns (Alg. 1) ─▶ GO-COT prompt │    tests
                                     │ ─▶ new candidates ─▶ run & score             │
                                     │ ─▶ Sol = RS ∪ NC                             │
                                     └──────────────────────────────────────────────┘
```

The paper's benchmark dataset (PIE) ships with pre-built test cases and a large mined pattern corpus — neither exists for arbitrary code a user selects in an editor. Two adaptations make this work as an interactive tool:

1. **No test cases exist for arbitrary code** — solved with a *differential test oracle*: an LLM call synthesizes diverse inputs, two large stress inputs are generated so timings reflect asymptotic behaviour, the original function runs once as ground truth, and the cases are split into public (used during the search) and private (final verification) sets.
2. **No training corpus at inference time** — the curated pattern base is indexed with the paper's own retrieval method, and a PIE-mined base can be added with `scripts/mine_patterns.py` and the `sbllmOptimizer.patternFile` setting.

Code above the target function is used as context (imports, constants, helpers), with statements that have side effects — `input()`, prints, file I/O, `main()` — removed first, so they never run during evaluation.

The search loop, fitness evaluation and test oracle are language-independent: they talk only to a `LanguageAdapter`. Python executes candidates in a subprocess; C++ compiles the candidate and the original into a single binary (each in its own namespace) so both are timed in the same process.

Full design rationale is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.85+
- [Node.js](https://nodejs.org/) 18+ (development only)
- For Python files: Python 3.9+ (`python`/`python3` on `PATH`, or set `sbllmOptimizer.pythonPath` — point it at your project's virtual environment so imports resolve)
- For C++ files: a C++17 compiler (`g++` on `PATH`, or set `sbllmOptimizer.cppCompiler`)
- One of:
  - [Ollama](https://ollama.com) running locally with a code model pulled (e.g. `ollama pull qwen2.5-coder:7b`)
  - A [Gemini API key](https://aistudio.google.com/)
  - An OpenAI API key, or any OpenAI-compatible server (set `sbllmOptimizer.openaiBaseUrl`)

## Getting started

```sh
git clone https://github.com/pronobkarmoker/sbllm-optimizer.git
cd sbllm-optimizer
npm install
```

Copy `.env.example` to `.env` if you want to use the CLI tools (`npm run optimize`, `npm run analyze`), and fill in your provider of choice.

Then open the parent workspace folder in VS Code and press **F5** (Run and Debug → "Run SBLLM Extension"). This compiles the extension and launches an Extension Development Host window with the `examples/` folder open.

In that window, open an example: flagged functions show an **⚡ SBLLM: … — Optimize** CodeLens. Click it — or place the cursor in any function and run **SBLLM: Optimize Selected Code** (right-click menu, the ⚡ button in the editor title bar, or the command palette).

### Choosing a model

- **Gemini:** run **SBLLM: Set Gemini API Key**, then set `sbllmOptimizer.llmProvider` to `"gemini"`.
- **OpenAI:** run **SBLLM: Set OpenAI API Key**, set `sbllmOptimizer.llmProvider` to `"openai"` and `sbllmOptimizer.openaiModel` to the model you want.
- **Local OpenAI-compatible server** (LM Studio, vLLM, ...): provider `"openai"`, and `sbllmOptimizer.openaiBaseUrl` set to e.g. `http://localhost:1234/v1` (no key needed).

Small local models (1–3B) work, but the search is far more effective with a 7B+ code model or a hosted model.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `sbllmOptimizer.llmProvider` | `"ollama"` | `"ollama"`, `"gemini"` or `"openai"` |
| `sbllmOptimizer.ollamaHost` | `http://127.0.0.1:11434` | Local Ollama server URL |
| `sbllmOptimizer.ollamaModel` | `qwen2.5-coder:1.5b` | Ollama model tag |
| `sbllmOptimizer.geminiModel` | `gemini-3.6-flash` | Gemini model |
| `sbllmOptimizer.openaiModel` | `gpt-5-mini` | Model for the OpenAI-compatible provider |
| `sbllmOptimizer.openaiBaseUrl` | *(empty)* | OpenAI-compatible endpoint; empty = OpenAI |
| `sbllmOptimizer.maxIterations` | `4` | Max evolutionary iterations (paper's tuned optimum) |
| `sbllmOptimizer.representativeSamples` | `3` | Ns — representative samples per iteration (paper's tuned optimum) |
| `sbllmOptimizer.generationNumber` | `4` | Candidates per generation and initial-population size (the paper's `generation_number`) |
| `sbllmOptimizer.minSpeedup` | `1.1` | Minimum verified speedup to count as an optimization (the paper's OPT threshold) |
| `sbllmOptimizer.pythonPath` | *(empty)* | Python interpreter for running/analyzing code |
| `sbllmOptimizer.cppCompiler` | *(empty)* | C++ compiler (default `g++`) |
| `sbllmOptimizer.patternFile` | *(empty)* | Extra JSON/JSONL pattern base, e.g. mined from PIE |
| `sbllmOptimizer.analysis.enabled` | `true` | Static inefficiency analysis (diagnostics) |
| `sbllmOptimizer.analysis.codeLens` | `true` | ⚡ Optimize CodeLens on flagged functions |
| `sbllmOptimizer.analysis.codeLensForAllFunctions` | `false` | Show the CodeLens on every top-level function |

In an untrusted workspace, that workspace's interpreter, compiler, pattern-file and endpoint settings are ignored, and nothing is executed.

### A note on `generationNumber`

The paper generates several candidates per iteration, and that breadth is what makes the search *evolutionary* rather than a linear chain: the population must be larger than `Ns` for representative selection to have anything to choose between, and for GO-COT's crossover step to have distinct methods to combine. Setting it to `1` is offered only because a slow local model makes the faithful default expensive in an interactive editor.

### Mining a pattern base from PIE

The paper retrieves patterns from PIE's training split. Download it (e.g. the [SBLLM processed data](https://zenodo.org/records/14096664) or [PIE](https://github.com/madaan/pie-perf)), then:

```sh
python scripts/mine_patterns.py path/to/train.jsonl --lang python --out patterns-python.json
```

and point `sbllmOptimizer.patternFile` at the output. Mined patterns are added to the built-in ones.

## Project structure

```
sbllm-optimizer/
├── src/
│   ├── core/               # Pure TypeScript, no VS Code dependency — testable standalone
│   │   ├── analysis/       # Static inefficiency analysis (C++ scanner; Python via analyze.py)
│   │   ├── optimizer/      # Algorithm 2: the evolutionary search loop
│   │   ├── fitness/        # Algorithm 1 (selection) + the differential test oracle
│   │   ├── pattern/        # Algorithm 1 (retrieval): pattern base, BM25, ds/df diffing
│   │   ├── prompt/         # GO-COT prompt construction and response parsing
│   │   ├── llm/            # Ollama / Gemini / OpenAI providers
│   │   ├── lang/           # LanguageAdapter + Python and C++ adapters, function ranges
│   │   │   ├── python/     # run_candidate.py, abstract.py, analyze.py (subprocess scripts)
│   │   │   └── cpp/        # Source scanner + generated compile-and-time harness
│   │   └── util/           # JSON repair, subprocess runner, cancellation
│   ├── vscode/             # Commands, diagnostics/CodeLens, insights panel, history, diff view
│   └── cli/                # `npm run optimize` / `npm run analyze` without VS Code
├── test/                   # node:test suite, incl. an end-to-end run with a scripted LLM
├── scripts/mine_patterns.py  # Builds a pattern base from the PIE dataset
├── examples/               # Sample inefficient Python and C++ files
└── docs/ARCHITECTURE.md    # Design rationale
```

## Commands

| Command | What it does |
|---|---|
| **SBLLM: Optimize Selected Code** | Runs the search on the function under the cursor / selection |
| **SBLLM: Analyze File for Performance Issues** | Lists the static-analysis findings for the file and jumps to them |
| **SBLLM: Compare Best Result** | Side-by-side comparison with syntactic and semantic similarity |
| **SBLLM: Apply Best Result** | Applies the verified best result of the current run |
| **SBLLM: Show Optimization History** | Browse past runs, re-open their diffs, copy their code |
| **SBLLM: Cancel Optimization** | Stops the search and reports the best verified result so far |
| **SBLLM: Set Gemini API Key** / **Set OpenAI API Key** | Stores a key in VS Code's `SecretStorage` |
| **SBLLM: Diagnose Ollama Connection** | Probes the configured Ollama host over several transports |

## Development

```sh
npm run typecheck      # tsc --noEmit
npm test               # unit + integration tests (Python/g++ tests skip if not installed)
npm run test:vscode    # drives the real extension in a separate, downloaded VS Code instance
npm run compile        # bundle the extension with esbuild
npm run watch          # rebuild on change
npm run package:vsix   # produce an installable .vsix
npm run analyze -- examples/inefficient.py       # static analysis from the CLI
npm run optimize -- examples/has_duplicate.py     # run the full search from the CLI
npm run optimize -- examples/has_duplicate.cpp    # language is chosen from the file extension
```

## Fidelity to the paper

Every component of the paper's method is implemented:

- **Algorithm 1, selection** — fitness from execution (accuracy + speedup), correct candidates sorted by speedup and deduplicated by AST abstraction, incorrect ones ranked by summed abstracted edit distance.
- **Algorithm 1, retrieval** — fine-grained pattern parsing into abstracted code `s_a` and deleted/added statements `d_s`/`d_f`; three BM25 indices (`b = 0.4`, as in the released code); `similar = argmax(input + sim)` and `different = argmax(input + dif)` with the released code's min-max/median scoring.
- **Algorithm 2** — CoT initial population, `RS_i` selection, the convergence check (`RS_i == RS_{i-1}` with a correct solution), `Sol ← RS_i ∪ NC`, final re-ranking.
- **GO-COT** — crossover / mutation / generation instructions, reasoning specification, input placeholder (Fig. 3).
- **Defaults** — the paper's tuned `Ns = 3`, 4 iterations, temperature 0.7, 4 candidates per generation; C++ with `-std=c++17 -O3`; a 10% speedup threshold as in the OPT metric.

Where the implementation departs from the paper, it's because the paper describes an offline benchmark pipeline and this is an interactive editor tool:

| Paper | Here | Why |
|---|---|---|
| Patterns mined from PIE's 36K+/78K training pairs | Curated patterns built in; a PIE-mined base is optional (`scripts/mine_patterns.py`) | Shipping the corpus inside the extension isn't practical |
| PIE's ~2.8 public / ~95.9 private test cases per problem | LLM-synthesized inputs plus generated stress inputs, the original function as its own oracle, split public/private | Arbitrary user code ships with no test suite |
| Mean of 25 runs, excluding the first | Batched `timeit`-style timing with the original re-timed in the same process | More reliable for the sub-millisecond functions common in an editor |
| Patterns shown as the edit's diff lines | Curated patterns shown as complete before/after example functions (long mined ones still as diffs) | Bare diff lines led small models to copy names that don't exist in the user's code; full examples: 6/6 vs 4/6 correct in a same-prompt comparison |
| Tree-sitter abstraction for C++ | Regex token abstraction | Avoids shipping a native grammar; equivalent for dedup and BM25 |

Algorithm 1 in the paper specifies `acc == 1` for the correct group, while the authors' released `merge.py` uses `acc > 0`. This implementation follows the paper.

## Known limitations

- **C++ signatures are restricted** — integer, floating-point, `bool`, `char` and `std::string` parameters/returns, plus `std::vector` of those (one level of nesting), passed by value or reference. Templates, pointers and user-defined types are reported clearly rather than guessed at.
- **Top-level functions only** — class methods and nested functions are analyzed but can't be optimized yet.
- **Synthesized test cases are a heuristic** — the oracle infers intended input types from the code. It cannot know a contract the code doesn't express, so an optimization correct for realistic inputs may still be rejected on an exotic one.
- **Static analysis is heuristic** — it flags likely problems for a human (and the optimizer) to look at; it doesn't prove complexity.
- **Code runs on your machine** — candidates are executed locally without a sandbox (hence the trusted-workspace requirement). Code above the target function is sent to the configured LLM as context.
- **Model-dependent quality** — small local models often fail at subtler rewrites; the oracle rejects wrong candidates rather than accepting them.

## Roadmap

- Class methods and more C++ parameter types (`std::map`, `std::pair`, user-defined types)
- Further languages (JavaScript, Java)
- A workspace-local pattern store that grows from accepted optimizations
- Optional sandboxing (container) for candidate execution

## Author

### Pronob Karmoker

📍 Dhaka, Bangladesh · 🔗 [github.com/pronobkarmoker](https://github.com/pronobkarmoker)

| | |
|:--|:--|
| 🎓 | **Software Engineering Student**<br>Institute of Information Technology (IIT), University of Dhaka |
| 💼 | **Ex Software Engineer Intern**<br>Ithra, Aramco |
| 📢 | **Ex Publicity Secretary**<br>IEEE Computer Society Student Branch, University of Dhaka |
| ⚙️ | **Ex Executive Member**<br>IITSEC |

> Built as a **Software Project Lab 3 (SPL3)** project at IIT, University of Dhaka — taking the SBLLM method from an offline research pipeline (ICSE'25) to an interactive developer tool that runs inside your editor.

## Reference

This project is an independent implementation of the method described in the following paper. It is not affiliated with, nor endorsed by, the paper's authors.

```bibtex
@inproceedings{gao2025sbllm,
  title     = {Search-Based LLMs for Code Optimization},
  author    = {Gao, Shuzheng and Gao, Cuiyun and Gu, Wenchao and Lyu, Michael R.},
  booktitle = {Proceedings of the 47th IEEE/ACM International Conference on Software Engineering (ICSE)},
  year      = {2025}
}
```

## License

[MIT](LICENSE)
