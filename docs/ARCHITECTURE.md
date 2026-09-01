# SBLLM-Optimizer — Architecture Design

Status: draft v1 · Author: design pass with Claude · Scope: full-extension architecture before any implementation

## 1. What we're actually building

The paper's SBLLM is an **offline research pipeline**: batch jobs over a fixed dataset (PIE) that already has
public/private test cases, a huge training corpus to mine patterns from, a 112-core server to burn on execution,
and no user waiting on the other end. A VS Code extension is the opposite of all five of those things. Porting
the *algorithm* (Algorithm 1 + Algorithm 2 from the paper) is straightforward; porting the *assumptions* is the
actual design problem. This document makes an explicit decision for each assumption instead of leaving it
implicit, because those seams are exactly where the bugs we just fixed in the reference repo came from
(language branches that silently fell back to the wrong parser, hardcoded constants that should've been config).

**Design goals**
- Faithful to the paper's mechanism (execution-based fitness → adaptive pattern retrieval → GO-COT generation →
  iterate), not just "call an LLM in a loop and call it SBLLM."
- Safe by default: never execute untrusted code, never apply a change, without explicit, visible user consent.
- Cheap by default: every LLM call and every code execution costs real time/money for the user — budget for
  that consciously, don't just replay the paper's `Ns=3, iterations=4` blindly.
- Decoupled core: the search engine has zero VS Code imports. It's a plain TypeScript library the extension
  happens to host. This makes it unit-testable without spinning up the Extension Host, and portable to a CLI
  or another editor later — cheap insurance for a thesis project that may need to demo outside VS Code too.

**Non-goals (explicitly out of scope for v1)**
- True security sandboxing (containers/VMs) against malicious generated code — v1 uses process isolation +
  timeouts + workspace trust gating, which is *advisory*, not a security boundary. Say this to users, don't
  imply more safety than exists.
- Full PIE-scale pattern base (36k/78k pairs) shipped in the extension. We ship a curated subset (§4).
- Refactoring across multiple files / whole-repo optimization. Scope is one function/selection at a time.

---

## 2. The two problems the paper doesn't have to solve, that we do

### 2.1 No test cases exist for arbitrary user code

SBLLM's fitness function (`accuracy`, `speedup`) is entirely built on PIE's public/private test cases. A user
selecting a function in their own repo has none of that. This is the single biggest gap between the paper and
the product, so it gets a first-class abstraction rather than a hack: **`TestOracleStrategy`**, three tiers,
escalating trust, auto-selected but user-overridable:

1. **User-supplied** (highest confidence). If the selection sits next to doctests, an adjacent `test_*.py` /
   `*.spec.ts`, or the user pastes example calls, use those directly as ground truth — this is literally the
   PIE setup, just sourced locally instead of from CodeNet.
2. **Differential testing against the original** (default path, general case). Extract the signature via
   tree-sitter → one LLM call to synthesize N diverse concrete inputs (including edge cases) → run the
   **original** code once in the sandbox to capture ground-truth outputs → every candidate's "accuracy" =
   output-equivalence against those, every candidate's "speedup" = wall-clock ratio, exactly mirroring the
   paper's `A(o)` / `T(o)` definitions. Split generated inputs into a "public" subset used during iteration and
   a held-out "private" subset used only for the final accept-gate — the paper itself found that too many
   iterations against the same public tests risks overfitting (§IV-D); with *synthetic* tests that risk is
   worse, so this split matters more here, not less.
3. **Static-only / no-execution** (always available, not a degraded fallback but a first-class mode). For
   side-effecting code, code touching a DB/network/filesystem, or a user who doesn't want anything executed:
   skip the execution-based fitness loop entirely, rank candidates by an LLM self-critique pass instead, and
   **label the result's confidence accordingly** in the UI. A lot of real code can't be safely run at all — this
   mode isn't a corner case.

Each result the UI shows carries an explicit provenance/confidence tag ("verified on 8/8 generated inputs" vs.
"unverified, static analysis only") — never let "optimized ✓" look the same regardless of how it was checked.

### 2.2 No training corpus exists at inference time

Pattern retrieval (§II-C of the paper) needs a large corpus of (slow, fast) pairs to mine `ds`/`df` from. We
can't ship 78k C++ pairs in a VSIX. Decision: ship a **small, curated, offline-mined pattern base** per language
(low hundreds of entries, not tens of thousands) — built once, offline, by literally running the reference
repo's fixed `merge.py` abstraction/diff logic (§1 of the earlier bugfix pass) against PIE, then hand-trimmed
for size and deduplicated. Supplement with hand-curated classic idioms (memoization, vectorization, algorithmic
complexity swaps, data-structure substitution, I/O batching) that aren't PIE-specific. Store as a static
JSON asset, loaded once, queried in-process with the same BM25 similar/different retrieval as Algorithm 1 —
same *mechanism*, smaller *corpus*. That's an honest, defensible scope cut worth stating explicitly rather than
pretending the pattern base is PIE-equivalent.

Stretch (post-MVP, and a genuine thesis-novel angle beyond the paper): opt-in, workspace-local pattern store
that grows every time a user *accepts* an optimization — the tool gets better at that codebase's own idioms
over time, entirely locally, no telemetry.

---

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ VS Code Host Layer            (src/vscode/*)                        │
│  commands · CodeLens · diff view · WebView panel · SecretStorage    │
│  · workspace trust gate · progress/cancellation                     │
└───────────────────────────────┬───────────────────────────────────┘
                                 │  plain data in/out, no VS Code types leak below this line
┌───────────────────────────────▼───────────────────────────────────┐
│ Orchestration            (src/core/optimizer/*)                     │
│  EvolutionaryOptimizer — mirrors Algorithm 2: init → iterate →      │
│  converge/stop, emits progress events, honors CancellationToken     │
└───┬─────────────┬─────────────┬─────────────┬─────────────┬────────┘
    │              │             │             │             │
┌───▼───┐   ┌──────▼─────┐ ┌─────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
│Fitness │   │  Pattern   │ │  Prompt    │ │   LLM    │ │  Sandbox   │
│Evaluator│  │ Retriever  │ │  Builder   │ │  Client  │ │  Runner    │
│(Alg.1a)│   │ (Alg.1b)   │ │ (GO-COT)   │ │(provider │ │(exec +     │
│        │   │            │ │            │ │agnostic) │ │ timeouts)  │
└───┬────┘   └─────┬──────┘ └────────────┘ └────┬─────┘ └─────┬──────┘
    │              │                             │             │
    │        ┌─────▼──────┐                ┌─────▼─────┐ ┌─────▼──────┐
    │        │PatternBase │                │  Gemini / │ │TestOracle  │
    │        │(bundled +  │                │  Ollama   │ │Generator   │
    │        │ workspace) │                │ providers │ │(§2.1)      │
    │        └────────────┘                └───────────┘ └────────────┘
    │
┌───▼─────────────────────────────────────────────────────────────────┐
│ LanguageAdapter (per-language plugin: py / js / cpp / sh)           │
│  parse+abstract (web-tree-sitter) · locate function boundary ·      │
│  run command · detect signature                                     │
└───────────────────────────────────────────────────────────────────┘
```

Everything below the dashed line in the diagram is VS Code-free TypeScript — testable with plain `vitest`/`jest`,
no Extension Host required.

---

## 4. AST abstraction: one mechanism, not two

The reference repo splits Python (`ast` + a hand-written `NodeTransformer`) from C++ (native tree-sitter with a
hand-built `.so`) — that fork is exactly what caused the `selection()` bug we just fixed (C++ abstraction
silently applied to Python code). For the extension, standardize on **`web-tree-sitter`** (WASM grammars) for
*every* language, one `AstAbstractor` class parameterized by grammar. Reasons this is the right call here
specifically, not just "consistency for its own sake":
- No native compilation step per OS/arch — critical for a VSIX that has to just work after install, unlike a
  research repo where the user is expected to build `tree-sitter-cpp` themselves.
- One abstraction pipeline means one dedup/edit-distance code path in `FitnessEvaluator`, so the exact class of
  bug we found (language-conditional logic that forgot to branch) structurally can't happen — there's nothing
  to forget to branch on.

```ts
interface LanguageAdapter {
  readonly id: 'python' | 'javascript' | 'cpp' | 'shell';
  abstract(code: string): AbstractedCode;          // AST → VAR/STR/NUM-normalized form
  locateEnclosingFunction(doc: TextDocument, sel: Range): FunctionSpan | null;
  inferSignature(span: FunctionSpan): ParamSignature[];
  run(code: string, input: unknown, opts: RunOptions): Promise<RunResult>;
}
```

---

## 5. Execution safety

- Every run gets a fresh temp dir, `child_process.spawn` with a hard wall-clock timeout, killed on timeout or
  memory overshoot (best-effort process stats on Windows; ulimit wrapper on POSIX).
- Gated behind `vscode.workspace.isTrusted` — the execution-based fitness path (tiers 2 in §2.1) simply isn't
  offered in an untrusted workspace; static-only mode still is.
- First-run consent dialog, explicit and specific: *"This runs your code and AI-generated variants of it
  locally to measure speed. Only enable this in workspaces you trust."* No silent opt-in.
- Missing runtime (no `python3`/`node`/`g++` on PATH) degrades gracefully to static-only mode with a clear
  inline message, not a stack trace.

---

## 6. LLM integration layer

```ts
interface LLMProvider {
  generate(prompt: Prompt, opts: { signal: AbortSignal; onToken?: (t: string) => void }): Promise<LLMResponse>;
}
```

- `GeminiProvider`, `OllamaProvider` per the proposal; API keys via `vscode.SecretStorage`, never plaintext
  settings.
- Response cache keyed by `hash(promptText)` — replaying an iteration (e.g. reopening VS Code mid-session)
  shouldn't re-bill.
- **Structured output over regex scraping.** The reference repo's `extract_py`/`extract_cpp` parse the GO-COT
  response with `content.count('provide a new optimized code snippet:**') == 1` style heuristics — brittle
  enough that we just fixed a bug in it. For the extension, request strict JSON (or function-calling where the
  provider supports it) for the 3-step GO-COT output instead of scraping markdown headings. This is a concrete
  improvement over the reference implementation, not just a port of it.

---

## 7. The evolutionary loop, retuned for a human waiting

Algorithm 2 ported almost directly, with defaults chosen for *interactive* latency instead of an offline batch
job with a research budget:

- `Ns = 2` (not 3), `maxIterations = 3` (not 4) by default — each iteration is an LLM round trip plus one or
  more sandboxed executions; both settings are user-configurable for anyone who wants paper-parity.
- VS Code `Progress` notification showing iteration number + current best speedup, backed by a real
  `CancellationToken` — the loop must check it between steps, not just at the top.
- Same convergence check as the paper (representative samples unchanged AND correct → stop), plus a wall-clock/
  call-count budget stop, since the paper's stopping condition assumes an unlimited research budget and a live
  user has a patience budget instead.
- "Refine Further" resumes the stored loop state rather than restarting cold — the loop is already stateful
  turn to turn, so this is nearly free once the core loop exists.

---

## 8. UI/UX flow

1. `SBLLM: Optimize Selected Code` — command palette + right-click, enabled when there's a selection or the
   cursor sits inside a function.
2. Capture selection + minimal surrounding context (imports, enclosing function/class) → run pipeline behind
   the `Progress` UI from §7.
3. Result diff shown via VS Code's **built-in diff editor** (`vscode.diff` + a virtual document content
   provider) — reuse native, accessible, familiar UI instead of a custom webview diff; less surface to own and
   get wrong.
4. A companion **"Optimization Insights"** WebView shows: the GO-COT 3-step reasoning trace, per-iteration
   correctness/speedup, the two retrieved patterns with their provenance, and explicit actions — Accept / Refine
   Further / Try a Different Candidate (top-1/3/5, paper-style, but user-chosen here instead of an offline
   metric) / Reject.
5. Accept applies via a `WorkspaceEdit` — never a silent write — so it's always a normal `Ctrl+Z` away from
   reverting.
6. Lightweight proactive hinting: CodeLens above functions using **cheap static heuristics only** (nested-loop
   depth, obvious repeated recomputation in a loop) — no LLM call just to decide whether to show a "⚡ Optimize"
   lens, so we're not spending API budget on suggestions nobody asked for yet.

---

## 9. Proposed repo layout

```
sbllm-optimizer/
├── docs/
│   └── ARCHITECTURE.md          (this file)
├── src/
│   ├── core/                    # zero VS Code imports — unit-testable standalone
│   │   ├── optimizer/
│   │   │   └── evolutionaryOptimizer.ts
│   │   ├── fitness/
│   │   │   ├── fitnessEvaluator.ts       # Algorithm 1a
│   │   │   └── testOracle/
│   │   │       ├── userSupplied.ts
│   │   │       ├── differential.ts
│   │   │       └── staticOnly.ts
│   │   ├── pattern/
│   │   │   ├── patternRetriever.ts       # Algorithm 1b, BM25 similar/different
│   │   │   └── patternBase.ts
│   │   ├── prompt/
│   │   │   └── goCotPromptBuilder.ts
│   │   ├── llm/
│   │   │   ├── llmProvider.ts            # interface
│   │   │   ├── geminiProvider.ts
│   │   │   └── ollamaProvider.ts
│   │   ├── sandbox/
│   │   │   └── sandboxRunner.ts
│   │   └── lang/
│   │       ├── languageAdapter.ts        # interface
│   │       ├── pythonAdapter.ts
│   │       ├── jsAdapter.ts
│   │       └── cppAdapter.ts
│   └── vscode/                  # thin adapter layer, all vscode.* imports live here
│       ├── extension.ts
│       ├── commands/optimizeSelection.ts
│       ├── ui/diffView.ts
│       ├── ui/insightsPanel.ts
│       ├── ui/codeLensProvider.ts
│       └── settings.ts
├── assets/
│   └── patternBase/{python,javascript,cpp}.json
├── test/                        # tests for src/core only, no Extension Host needed
└── package.json
```

---

## 10. Phased roadmap

Sequenced by risk, not by feature list — the riskiest unknowns (does the search loop actually help on a
real function? does differential testing produce trustworthy inputs?) get proven before any VS Code chrome
is built, so a bad answer there doesn't waste UI work.

| Phase | Deliverable | Why this order |
|---|---|---|
| 0 | Core engine skeleton, Python-only, Ollama provider, CLI-driven (no VS Code) | Prove the search loop end-to-end on toy examples before touching the Extension Host |
| 1 | VS Code shell — command, diff view, progress, settings, SecretStorage | Get something clickable early for supervisor checkpoints |
| 2 | `FitnessEvaluator` + differential test oracle (tier 2) + sandbox + workspace-trust gate | The hardest correctness-and-safety problem; needs its own hardening pass |
| 3 | Pattern base (offline-mined from PIE via the fixed `merge.py`) + retrieval | Depends on nothing above; can be built in parallel with Phase 2 |
| 4 | GO-COT structured prompting, multi-candidate ranking, "Refine Further" | Ties orchestration together end to end |
| 5 | Multi-language (JS/C++ adapters), Insights panel, CodeLens, caching | Breadth, once the single-language path is solid |
| 6 (stretch, thesis-novel) | Opt-in growing workspace-local pattern store; evaluate against a PIE-style benchmark for the thesis writeup itself (your own RQ1/RQ2-style results section) | Differentiates from a straight port; doubles as evaluation material |

---

## 11. Open questions for you (not blocking, but worth deciding early)

- **Ollama vs. Gemini as the default** during development — Ollama is free/local and better for iterating on
  prompts without burning API quota; Gemini is what the shipped extension likely defaults to for quality. Build
  provider-agnostic from day one either way (already reflected in §6).
- **How much of Phase 0 do you want runnable before we touch VS Code at all?** A CLI-only proof that the
  evolutionary loop beats a single-shot COT prompt on a handful of hand-picked slow functions would also make a
  strong midterm-presentation artifact, independent of the extension shipping.
- **License/attribution**: the pattern base is derived from PIE/CodeNet — worth confirming what the dataset
  license permits for redistribution inside a VSIX before Phase 3.
