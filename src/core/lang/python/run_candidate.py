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


def timed_call(func, args):
    # Exactly one call is used for correctness (return value + printed output) — on a fresh deep
    # copy of args, since some candidates sort/mutate their input in place, and the caller compares
    # this against ground truth captured the same way.
    buf = io.StringIO()
    call_args = copy.deepcopy(args)
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(buf):
        output = func(*call_args)
    first_call_ms = (time.perf_counter() - t0) * 1000
    stdout_text = buf.getvalue()

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
            return output, stdout_text, statistics.median(times)

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
        return output, stdout_text, avg_ms
    finally:
        if gc_was_enabled:
            gc.enable()


def load_func(code, func_name, label):
    namespace = {}
    exec(compile(code, label, 'exec'), namespace)
    func = namespace.get(func_name)
    if func is None or not callable(func):
        raise NameError('function {} not found or not callable'.format(func_name))
    return func


def main():
    payload = json.loads(sys.stdin.read())
    code = payload['code']
    func_name = payload['funcName']
    inputs = payload['inputs']
    baseline_code = payload.get('baselineCode')

    try:
        func = load_func(code, func_name, '<candidate>')
    except Exception as e:
        print(json.dumps({'compileError': '{}: {}'.format(type(e).__name__, e)}))
        return

    # Loaded into a SEPARATE namespace so its function of the same name doesn't get overwritten
    # by (or overwrite) the candidate's. Re-measuring the baseline here — in the same subprocess,
    # immediately alongside every candidate call — matters more than it might look: without this,
    # the baseline is measured once, at the very start of a search session, and every candidate
    # afterward is measured minutes later in its own separate process launch. If system conditions
    # drift over the session (background load, thermal state, whatever), that's not symmetric
    # noise around the true ratio — it's a directional bias, since only one side of the comparison
    # drifts. Measuring both together, in the same process, at the same moment, cancels that out:
    # if the whole machine is 10% slower right now, both sides are equally affected and the RATIO
    # stays accurate even though neither absolute number is exactly what it "should" be.
    baseline_func = None
    if baseline_code:
        try:
            baseline_func = load_func(baseline_code, func_name, '<baseline>')
        except Exception:
            baseline_func = None

    results = []
    for args in inputs:
        start = time.perf_counter()
        try:
            output, stdout_text, avg_ms = timed_call(func, args)
            try:
                json.dumps(output)
            except TypeError:
                output = repr(output)
            # A function's printed output is part of its observable behavior — many real
            # functions (like ones that only print(), never return) communicate ONLY this way.
            # Comparing return values alone would call two candidates "equal" even when their
            # printed output completely differs.
            entry = {'ok': True, 'output': output, 'stdout': stdout_text, 'timeMs': avg_ms}

            if baseline_func is not None:
                try:
                    _, _, baseline_ms = timed_call(baseline_func, args)
                    entry['baselineTimeMs'] = baseline_ms
                except Exception:
                    pass  # a baseline re-run hiccup shouldn't fail the candidate's own evaluation

            results.append(entry)
        except Exception as e:
            elapsed = (time.perf_counter() - start) * 1000
            results.append({'ok': False, 'error': '{}: {}'.format(type(e).__name__, e), 'timeMs': elapsed})

    print(json.dumps({'results': results}))


if __name__ == '__main__':
    main()
