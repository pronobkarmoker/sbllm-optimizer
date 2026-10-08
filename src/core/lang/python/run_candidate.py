import sys
import json
import time
import io
import copy
import gc
import statistics
import contextlib

# Per the paper's own methodology (§III-E): "we execute each slow and generated program 25 times,
# and report the average execution results excluding the first run." Timing a handful of individual
# calls isn't enough samples for a fast function — a sub-millisecond call's own measurement overhead
# (interpreter dispatch, GC, OS scheduling jitter) is comparable in size to the thing being measured.
# The fix mirrors Python's own `timeit` module: batch enough repeats together that per-call noise
# averages out, rather than trusting a few individually-timed calls.
MAX_TOTAL_TRIAL_TIME_S = 2.0       # hard ceiling so a genuinely slow candidate can't stall a batch
TARGET_TIMING_DURATION_S = 0.15    # aim to spend at least this long in the batched timing loop
SLOW_CALL_THRESHOLD_MS = 100       # above this, a call is already slow enough that few repeats suffice
MAX_REPEATS = 5000                 # sanity cap for a pathologically fast function

# The result line is tagged so the caller can find it even if the code under test wrote to the real
# stdout (e.g. `print(..., end="")` at module level), which would otherwise share a line with it.
RESULT_MARKER = '__SBLLM_RESULT__'

# The real stdout, captured before any user code runs: user code may rebind or close sys.stdout.
_REAL_STDOUT = sys.stdout


def emit(obj):
    _REAL_STDOUT.write('\n' + RESULT_MARKER + json.dumps(obj) + '\n')
    _REAL_STDOUT.flush()


def to_jsonable(value, depth=0):
    """Canonical, JSON-safe form of a return value, so two processes agree on it.

    Sets used to fall back to repr(), and str hashing is randomized per process, so a function
    returning {'apple', 'banana'} printed its elements in a different order every run and failed
    against its own ground truth. Sets are now emitted sorted; tuples become lists (as JSON would);
    dicts with non-string keys become sorted [key, value] pairs.
    """
    if depth > 50:
        return repr(value)
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float('inf'), float('-inf')):
            return repr(value)
        return value
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v, depth + 1) for v in value]
    if isinstance(value, (set, frozenset)):
        items = [to_jsonable(v, depth + 1) for v in value]
        return {'__set__': sorted(items, key=lambda v: json.dumps(v, sort_keys=True))}
    if isinstance(value, dict):
        if all(isinstance(k, str) for k in value):
            return {k: to_jsonable(v, depth + 1) for k, v in value.items()}
        pairs = [[to_jsonable(k, depth + 1), to_jsonable(v, depth + 1)] for k, v in value.items()]
        return {'__dict__': sorted(pairs, key=lambda p: json.dumps(p[0], sort_keys=True))}
    # Anything else (custom objects, generators, numpy arrays...) — iterables are materialized when
    # that's safe; everything else is compared by repr().
    try:
        if hasattr(value, 'tolist'):
            return to_jsonable(value.tolist(), depth + 1)
    except Exception:
        pass
    return repr(value)


def timed_call(func, args):
    # Exactly one call is used for correctness (return value + printed output + the arguments' state
    # afterwards) — on a fresh deep copy of args, since some candidates sort/mutate their input in
    # place, and the caller compares this against ground truth captured the same way.
    buf = io.StringIO()
    call_args = copy.deepcopy(args)
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(buf):
        output = func(*call_args)
    first_call_ms = (time.perf_counter() - t0) * 1000
    stdout_text = buf.getvalue()
    args_after = call_args

    remaining_budget_s = max(0.05, MAX_TOTAL_TRIAL_TIME_S - first_call_ms / 1000)

    # timeit disables the garbage collector during timed regions by default, specifically because
    # a GC pause landing inside one call and not another is a real, well-known source of exactly
    # this kind of run-to-run noise. Always re-enabled afterward, even on an exception.
    gc_was_enabled = gc.isenabled()
    gc.disable()
    try:
        if first_call_ms >= SLOW_CALL_THRESHOLD_MS:
            # Already slow enough that per-call overhead is negligible next to the work being
            # measured — a handful of individually-timed repeats gives a stable estimate. Median,
            # not mean, so one call coinciding with an OS scheduling blip doesn't skew the result.
            times = [first_call_ms]
            budget_start = time.perf_counter()
            for _ in range(8):
                if time.perf_counter() - budget_start > remaining_budget_s:
                    break
                call_args = copy.deepcopy(args)
                t0 = time.perf_counter()
                with contextlib.redirect_stdout(io.StringIO()):
                    func(*call_args)
                times.append((time.perf_counter() - t0) * 1000)
            return output, stdout_text, args_after, statistics.median(times)

        # Fast call: batch many repeats (timeit-style) so per-call measurement noise averages out.
        # Each repeat gets its own deep-copied args, prepared up front so the copying itself isn't
        # included in the timed region — only the actual function calls are being timed.
        per_call_estimate_s = max(first_call_ms / 1000, 1e-6)
        repeats = min(MAX_REPEATS, max(10, int(TARGET_TIMING_DURATION_S / per_call_estimate_s)))
        prepared = [copy.deepcopy(args) for _ in range(repeats)]

        count = 0
        batch_start = time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):
            for call_args in prepared:
                func(*call_args)
                count += 1
                if time.perf_counter() - batch_start > remaining_budget_s:
                    break
        batch_elapsed_ms = (time.perf_counter() - batch_start) * 1000

        avg_ms = (batch_elapsed_ms / count) if count > 0 else first_call_ms
        return output, stdout_text, args_after, avg_ms
    finally:
        if gc_was_enabled:
            gc.enable()


def load_func(code, func_name, label):
    namespace = {'__name__': '__sbllm_' + label.strip('<>') + '__'}
    # Module-level code in the file context may print; that output is not part of the function's
    # behaviour and must not reach the real stdout.
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(code, label, 'exec'), namespace)
    func = namespace.get(func_name)
    if func is None or not callable(func):
        raise NameError('function {} not found or not callable'.format(func_name))
    return func


def describe(e):
    return '{}: {}'.format(type(e).__name__, e)


def main():
    payload = json.loads(sys.stdin.read())
    code = payload['code']
    func_name = payload['funcName']
    inputs = payload['inputs']
    baseline_code = payload.get('baselineCode')

    # BaseException, not Exception: a candidate calling sys.exit() or raising KeyboardInterrupt
    # used to kill this process without printing anything, and that aborted the whole search.
    try:
        func = load_func(code, func_name, '<candidate>')
    except BaseException as e:
        emit({'compileError': describe(e)})
        return

    # Loaded into a SEPARATE namespace so its function of the same name doesn't get overwritten
    # by (or overwrite) the candidate's. Re-measuring the baseline here — in the same subprocess,
    # immediately alongside every candidate call — matters more than it might look: without this,
    # the baseline is measured once, at the very start of a search session, and every candidate
    # afterward is measured minutes later in its own separate process launch. If system conditions
    # drift over the session (background load, thermal state, whatever), that's not symmetric
    # noise around the true ratio — it's a directional bias, since only one side of the comparison
    # drifts. Measuring both together, in the same process, at the same moment, cancels that out.
    baseline_func = None
    if baseline_code:
        try:
            baseline_func = load_func(baseline_code, func_name, '<baseline>')
        except BaseException:
            baseline_func = None

    # Correctness-only mode (random testing, mutation analysis, determinism checks): one call per
    # input, no repeated timing and no baseline — hundreds of inputs then take well under a second.
    timing = payload.get('timing', True)

    results = []
    for args in inputs:
        start = time.perf_counter()
        try:
            if timing:
                output, stdout_text, args_after, avg_ms = timed_call(func, args)
            else:
                buf = io.StringIO()
                call_args = copy.deepcopy(args)
                with contextlib.redirect_stdout(buf):
                    output = func(*call_args)
                stdout_text, args_after, avg_ms = buf.getvalue(), call_args, (time.perf_counter() - start) * 1000
            # A function's printed output and its effect on mutable arguments are part of its
            # observable behaviour — comparing return values alone would call an in-place sort
            # that returns None "equal" to one that does nothing at all.
            entry = {
                'ok': True,
                'output': to_jsonable(output),
                'stdout': stdout_text,
                'argsAfter': to_jsonable(args_after),
                'timeMs': avg_ms,
            }

            if baseline_func is not None and timing:
                try:
                    _, _, _, baseline_ms = timed_call(baseline_func, args)
                    entry['baselineTimeMs'] = baseline_ms
                except BaseException:
                    pass  # a baseline re-run hiccup shouldn't fail the candidate's own evaluation

            results.append(entry)
        except BaseException as e:
            elapsed = (time.perf_counter() - start) * 1000
            results.append({'ok': False, 'error': describe(e), 'errorType': type(e).__name__, 'timeMs': elapsed})

    emit({'results': results})


if __name__ == '__main__':
    main()
