"""Static analysis for Python sources — parses with `ast`, never executes anything.

Two modes, selected by the JSON payload on stdin:

  {"mode": "analyze", "code": "..."}
      Finds functions and flags common inefficiency patterns in each: nested loops, linear
      membership tests inside loops, loop-invariant recomputation, quadratic string/list building,
      list.pop(0), exponential recursion without memoization, and sorting just to take a min/max.
      This is the "Intelligent Code Analysis" step that decides which functions are worth handing
      to the (expensive) search-based optimizer at all.

  {"mode": "context", "code": "..."}
      Given everything above the target function, keeps only what the function can depend on
      without side effects — imports, definitions and constant-like assignments — and drops the
      rest. Without this, a top-level `n = input()` or file write ran on every single evaluation.
"""
import ast
import json
import sys

LOOP_NODES = (ast.For, ast.AsyncFor, ast.While)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
MEMO_DECORATORS = {'lru_cache', 'cache', 'memoize', 'memoized', 'cached'}
# Builtins whose cost is linear (or worse) in their argument — recomputing them on unchanged input
# inside a loop is pure waste. len() is O(1) and deliberately absent.
LINEAR_BUILTINS = {'sum', 'max', 'min', 'sorted', 'set', 'list', 'tuple', 'any', 'all', 'dict', 'frozenset'}


def call_name(node):
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name):
            return node.func.id
        if isinstance(node.func, ast.Attribute):
            return node.func.attr
    return None


def names_in(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def is_trivial_loop(loop):
    """A loop over a small fixed collection (`for d in range(4)`, `for dx, dy in ((0,1),(1,0))`)
    doesn't change the asymptotic cost, so nesting it is not worth flagging."""
    if isinstance(loop, ast.While):
        return False
    it = loop.iter
    if isinstance(it, (ast.Tuple, ast.List, ast.Set, ast.Constant)):
        return True
    if isinstance(it, ast.Call) and call_name(it) == 'range':
        args = it.args
        if args and all(isinstance(a, ast.Constant) and isinstance(a.value, int) for a in args):
            bound = args[1].value - args[0].value if len(args) >= 2 else args[0].value
            return abs(bound) <= 16
    return False


def issue(kind, severity, node, message, suggestion):
    return {
        'kind': kind,
        'severity': severity,
        'line': getattr(node, 'lineno', 1),
        'col': getattr(node, 'col_offset', 0),
        'endLine': getattr(node, 'end_lineno', getattr(node, 'lineno', 1)),
        'endCol': getattr(node, 'end_col_offset', getattr(node, 'col_offset', 0) + 1),
        'message': message,
        'suggestion': suggestion,
    }


class FunctionAnalyzer:
    def __init__(self, func):
        self.func = func
        self.issues = []
        self.list_names = set()
        self.str_names = set()
        self.reported = set()
        self._collect_bindings()

    def _collect_bindings(self):
        # Parameters annotated as lists count as lists.
        for arg in self.func.args.args + self.func.args.kwonlyargs:
            ann = arg.annotation
            if ann is not None:
                text = ast.unparse(ann).lower()
                if text.startswith('list') or text.startswith('typing.list'):
                    self.list_names.add(arg.arg)
        for node in self._walk_own(self.func):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                value = node.value
                if value is None:
                    continue
                for t in targets:
                    if not isinstance(t, ast.Name):
                        continue
                    if isinstance(value, (ast.List, ast.ListComp)) or call_name(value) == 'list':
                        self.list_names.add(t.id)
                    if (isinstance(value, ast.Constant) and isinstance(value.value, str)) or isinstance(
                        value, ast.JoinedStr
                    ) or call_name(value) == 'str':
                        self.str_names.add(t.id)

    def _walk_own(self, node):
        """ast.walk, but not into nested function/lambda/class bodies — those are analyzed
        (or not) on their own; their loops don't run per iteration of ours."""
        stack = list(ast.iter_child_nodes(node))
        while stack:
            n = stack.pop()
            yield n
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                continue
            stack.extend(ast.iter_child_nodes(n))

    def run(self):
        self._loops(self.func.body, [])
        self._recursion()
        self._sort_for_extreme()
        return self.issues

    # ---- loop-based detectors -------------------------------------------------------------

    def _loops(self, stmts, loop_stack):
        for stmt in stmts:
            self._visit(stmt, loop_stack)

    def _visit(self, node, loop_stack):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, LOOP_NODES):
            if not loop_stack:
                depth = self._nest_depth(node)
                if depth >= 2:
                    self.issues.append(issue(
                        'nested-loops',
                        'warning',
                        node,
                        'Loops nested {} deep — this is likely O(n^{}) in the input size.'.format(depth, depth),
                        'Look for a hash set/dict lookup, sorting + two pointers, or prefix sums that remove an inner loop.',
                    ))
            self._loop_body_checks(node, loop_stack + [node])
            for child in ast.iter_child_nodes(node):
                self._visit(child, loop_stack + [node])
            return
        for child in ast.iter_child_nodes(node):
            self._visit(child, loop_stack)

    def _nest_depth(self, node):
        """Depth of non-trivial loop nesting rooted at `node` (comprehension generators count)."""
        own = 0
        if isinstance(node, LOOP_NODES):
            own = 0 if is_trivial_loop(node) else 1
        elif isinstance(node, COMPREHENSIONS):
            own = sum(0 if isinstance(g.iter, (ast.Tuple, ast.List, ast.Constant)) else 1 for g in node.generators)
        best = 0
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                continue
            best = max(best, self._nest_depth(child))
        return own + best

    def _assigned_in(self, loop):
        """Names rebound or mutated inside the loop (assignment targets, loop targets, and receivers
        of mutating method calls). A call whose arguments touch any of these is not invariant."""
        changed = set()
        for n in self._walk_own(loop):
            if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for t in targets:
                    changed |= names_in(t)
            elif isinstance(n, (ast.For, ast.AsyncFor, ast.comprehension)):
                changed |= names_in(n.target)
            elif isinstance(n, ast.NamedExpr):
                changed |= names_in(n.target)
            elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                if isinstance(n.func.value, ast.Name):
                    changed.add(n.func.value.id)
            elif isinstance(n, ast.Delete):
                for t in n.targets:
                    changed |= names_in(t)
        if isinstance(loop, (ast.For, ast.AsyncFor)):
            changed |= names_in(loop.target)
        return changed

    def _loop_body_checks(self, loop, loop_stack):
        changed = self._assigned_in(loop)
        body_nodes = []
        for stmt in loop.body + getattr(loop, 'orelse', []):
            body_nodes.append(stmt)
            body_nodes.extend(self._walk_own(stmt))
        if isinstance(loop, ast.While):
            body_nodes.append(loop.test)
            body_nodes.extend(self._walk_own(loop.test))

        # Shared across loops: an inner loop's body is also part of its outer loop's body, so the
        # same finding would otherwise be reported once per enclosing loop.
        def once(key, item):
            if key not in self.reported:
                self.reported.add(key)
                self.issues.append(item)

        for n in body_nodes:
            # Linear membership test against a list, repeated every iteration.
            if isinstance(n, ast.Compare):
                for op, comp in zip(n.ops, n.comparators):
                    if isinstance(op, (ast.In, ast.NotIn)) and isinstance(comp, ast.Name) and comp.id in self.list_names:
                        once(('in', comp.id, n.lineno), issue(
                            'list-membership-in-loop',
                            'warning',
                            n,
                            '`in {}` scans the whole list on every loop iteration (O(n) each time).'.format(comp.id),
                            'Keep a set alongside (or instead of) the list for O(1) membership tests.',
                        ))
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
                recv = n.func.value
                attr = n.func.attr
                if attr in ('index', 'count') and isinstance(recv, ast.Name) and recv.id in self.list_names:
                    once(('idx', recv.id, n.lineno), issue(
                        'list-search-in-loop',
                        'warning',
                        n,
                        '`{}.{}()` is a linear scan, repeated on every loop iteration.'.format(recv.id, attr),
                        'Precompute a dict (value -> index / count) once before the loop.',
                    ))
                if attr == 'pop' and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == 0:
                    once(('pop0', n.lineno), issue(
                        'list-pop-front',
                        'warning',
                        n,
                        '`.pop(0)` shifts every remaining element — O(n) per call inside a loop.',
                        'Use collections.deque and popleft(), or iterate with an index.',
                    ))
                if attr == 'insert' and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == 0:
                    once(('ins0', n.lineno), issue(
                        'list-insert-front',
                        'warning',
                        n,
                        '`.insert(0, ...)` shifts every element — O(n) per call inside a loop.',
                        'Use collections.deque.appendleft(), or append and reverse once at the end.',
                    ))
            # Loop-invariant recomputation of a linear-cost builtin.
            name = call_name(n)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and name in LINEAR_BUILTINS and n.args:
                used = set()
                for a in n.args:
                    used |= names_in(a)
                if used and not (used & changed) and not any(isinstance(x, (ast.Call,) + COMPREHENSIONS) for a in n.args for x in ast.walk(a)):
                    once(('inv', name, n.lineno), issue(
                        'loop-invariant-computation',
                        'warning',
                        n,
                        '`{}` is recomputed on every iteration, but its inputs never change inside the loop.'.format(
                            ast.unparse(n)[:60]
                        ),
                        'Compute it once before the loop and reuse the result.',
                    ))
            # Quadratic string building.
            if isinstance(n, ast.AugAssign) and isinstance(n.op, ast.Add) and isinstance(n.target, ast.Name):
                if n.target.id in self.str_names:
                    once(('strcat', n.target.id), issue(
                        'string-concat-in-loop',
                        'info',
                        n,
                        'Building the string `{}` with += in a loop can be O(n^2).'.format(n.target.id),
                        "Collect the pieces in a list and ''.join() them once.",
                    ))
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                tgt = n.targets[0].id
                v = n.value
                if isinstance(v, ast.BinOp) and isinstance(v.op, ast.Add) and isinstance(v.left, ast.Name) and v.left.id == tgt:
                    if tgt in self.list_names:
                        once(('listcat', tgt), issue(
                            'list-concat-in-loop',
                            'warning',
                            n,
                            '`{0} = {0} + ...` copies the whole list on every iteration — O(n^2).'.format(tgt),
                            'Use .append() / .extend(), which grow the list in place.',
                        ))
                    elif tgt in self.str_names:
                        once(('strcat', tgt), issue(
                            'string-concat-in-loop',
                            'info',
                            n,
                            '`{0} = {0} + ...` rebuilds the string on every iteration — can be O(n^2).'.format(tgt),
                            "Collect the pieces in a list and ''.join() them once.",
                        ))

    # ---- whole-function detectors -----------------------------------------------------------

    def _recursion(self):
        fname = self.func.name
        for dec in self.func.decorator_list:
            target = dec.func if isinstance(dec, ast.Call) else dec
            dname = target.attr if isinstance(target, ast.Attribute) else getattr(target, 'id', '')
            if dname in MEMO_DECORATORS:
                return
        calls = [n for n in self._walk_own(self.func) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == fname]
        if len(calls) < 2:
            return
        # A hand-rolled memo table (dict named memo/cache/dp...) means it is already memoized.
        for n in self._walk_own(self.func):
            if isinstance(n, ast.Name) and any(k in n.id.lower() for k in ('memo', 'cache', 'dp', 'seen')):
                return
        self.issues.append(issue(
            'exponential-recursion',
            'warning',
            calls[0],
            '`{}` calls itself {} times per invocation without memoization — overlapping subproblems '
            'make this exponential.'.format(fname, len(calls)),
            'Add @functools.lru_cache(maxsize=None), or rewrite bottom-up with a table.',
        ))

    def _sort_for_extreme(self):
        for n in self._walk_own(self.func):
            if isinstance(n, ast.Subscript) and call_name(n.value) == 'sorted':
                idx = n.slice
                if isinstance(idx, ast.Constant) and idx.value == 0 or (
                    isinstance(idx, ast.UnaryOp) and isinstance(idx.op, ast.USub) and isinstance(idx.operand, ast.Constant) and idx.operand.value == 1
                ):
                    self.issues.append(issue(
                        'sort-for-min-max',
                        'info',
                        n,
                        'Sorting the whole sequence just to take one end is O(n log n).',
                        'min()/max() find the same element in O(n).',
                    ))


def complexity_of(func, issues):
    if any(i['kind'] == 'exponential-recursion' for i in issues):
        return 'exponential'
    analyzer = FunctionAnalyzer(func)
    depth = 0
    for stmt in func.body:
        depth = max(depth, analyzer._nest_depth(stmt))
    if depth == 0:
        return 'O(1)'
    return 'O(n)' if depth == 1 else 'O(n^{})'.format(depth)


def analyze(code):
    tree = ast.parse(code)
    functions = []

    def visit(body, top_level, class_name=None):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                start = min([d.lineno for d in node.decorator_list] + [node.lineno])
                issues = FunctionAnalyzer(node).run()
                functions.append({
                    'name': node.name if not class_name else '{}.{}'.format(class_name, node.name),
                    'line': start,
                    'defLine': node.lineno,
                    'endLine': node.end_lineno,
                    'topLevel': top_level,
                    'async': isinstance(node, ast.AsyncFunctionDef),
                    'complexity': complexity_of(node, issues),
                    'issues': sorted(issues, key=lambda i: (i['line'], i['col'])),
                })
            elif isinstance(node, ast.ClassDef):
                visit(node.body, False, node.name)

    visit(tree.body, True)
    return {'ok': True, 'functions': functions}


# ---- context filtering ------------------------------------------------------------------------

SAFE_CALL_NAMES = {
    'set', 'frozenset', 'dict', 'list', 'tuple', 'range', 'int', 'float', 'str', 'bool', 'complex',
    'bytes', 'len', 'sorted', 'abs', 'min', 'max', 'sum', 'pow', 'round', 'enumerate', 'zip', 'map',
    'filter', 'reversed', 'chr', 'ord', 'defaultdict', 'Counter', 'deque', 'OrderedDict', 'namedtuple',
    'compile', 'partial', 'TypeVar', 'NamedTuple', 'Decimal', 'Fraction', 'dataclass', 'field',
}
SAFE_MODULES = {'math', 're', 'collections', 'itertools', 'functools', 'string', 'operator', 'decimal',
                'fractions', 'typing', 'heapq', 'bisect', 'cmath', 'enum', 'dataclasses'}


def is_safe_expr(node):
    for n in ast.walk(node):
        if isinstance(n, (ast.Await, ast.Yield, ast.YieldFrom)):
            return False
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name) and f.id in SAFE_CALL_NAMES:
                continue
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in SAFE_MODULES:
                continue
            return False
    return True


def keep_statement(node):
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return True
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        return node.value is None or is_safe_expr(node.value)
    if isinstance(node, ast.Expr):
        v = node.value
        if isinstance(v, ast.Constant):
            return True  # docstring / bare literal
        if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == 'setrecursionlimit':
            return True  # common in recursive solutions, and harmless
        return False
    if isinstance(node, ast.Try):
        # `try: import fast_lib  except ImportError: fast_lib = None`
        return all(keep_statement(s) for s in node.body) and all(
            all(keep_statement(s) for s in h.body) for h in node.handlers
        )
    return False


def filter_context(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {'ok': False, 'error': str(e), 'code': code, 'skipped': []}
    lines = code.split('\n')
    kept, skipped = [], []
    for node in tree.body:
        start = min([d.lineno for d in getattr(node, 'decorator_list', [])] + [node.lineno])
        segment = '\n'.join(lines[start - 1:node.end_lineno])
        if keep_statement(node):
            kept.append(segment)
        else:
            skipped.append({'line': start, 'text': segment.split('\n')[0][:80]})
    return {'ok': True, 'code': '\n'.join(kept) + ('\n' if kept else ''), 'skipped': skipped}


# ---- candidate repair: missing standard-library imports -------------------------------------------

# Names models commonly use without importing them, and the import that provides each.
KNOWN_IMPORTS = {
    'lru_cache': 'from functools import lru_cache', 'cache': 'from functools import cache',
    'reduce': 'from functools import reduce', 'partial': 'from functools import partial',
    'cmp_to_key': 'from functools import cmp_to_key',
    'Counter': 'from collections import Counter', 'defaultdict': 'from collections import defaultdict',
    'deque': 'from collections import deque', 'OrderedDict': 'from collections import OrderedDict',
    'bisect_left': 'from bisect import bisect_left', 'bisect_right': 'from bisect import bisect_right',
    'bisect': 'import bisect', 'insort': 'from bisect import insort',
    'heappush': 'from heapq import heappush', 'heappop': 'from heapq import heappop',
    'heapify': 'from heapq import heapify', 'nlargest': 'from heapq import nlargest',
    'nsmallest': 'from heapq import nsmallest',
    'combinations': 'from itertools import combinations', 'permutations': 'from itertools import permutations',
    'product': 'from itertools import product', 'accumulate': 'from itertools import accumulate',
    'groupby': 'from itertools import groupby', 'chain': 'from itertools import chain',
    'islice': 'from itertools import islice',
    'gcd': 'from math import gcd', 'isqrt': 'from math import isqrt', 'inf': 'from math import inf',
    'math': 'import math', 'itertools': 'import itertools', 'collections': 'import collections',
    'functools': 'import functools', 'heapq': 'import heapq', 're': 'import re', 'sys': 'import sys',
    'string': 'import string', 'operator': 'import operator',
}


def bound_names(tree):
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
            a = n.args if not isinstance(n, ast.ClassDef) else None
            if a:
                for arg in a.posonlyargs + a.args + a.kwonlyargs + [a.vararg, a.kwarg]:
                    if arg:
                        names.add(arg.arg)
        elif isinstance(n, ast.Lambda):
            for arg in n.args.posonlyargs + n.args.args + n.args.kwonlyargs:
                names.add(arg.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for alias in n.names:
                names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            names.add(n.id)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            names.update(n.names)
    return names


def repair_imports(code, context):
    """Adds imports for well-known standard-library names the code uses but never imports or defines
    (and that the file context doesn't provide either)."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {'ok': False, 'code': code, 'added': []}
    bound = bound_names(tree)
    try:
        bound |= bound_names(ast.parse(context or ''))
    except SyntaxError:
        pass
    builtin_names = set(dir(__builtins__)) if not isinstance(__builtins__, dict) else set(__builtins__)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    missing = sorted(n for n in used - bound - builtin_names if n in KNOWN_IMPORTS)
    if not missing:
        return {'ok': True, 'code': code, 'added': []}
    as_module = {n.value.id for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)}

    def import_for(name):
        # `bisect` is both a module and a function in it; pick by how the code uses it.
        if name == 'bisect' and 'bisect' not in as_module:
            return 'from bisect import bisect'
        return KNOWN_IMPORTS[name]

    imports = sorted({import_for(n) for n in missing})
    return {'ok': True, 'code': '\n'.join(imports) + '\n\n' + code, 'added': imports}


def main():
    payload = json.loads(sys.stdin.read())
    mode = payload.get('mode', 'analyze')
    code = payload.get('code', '')
    try:
        if mode == 'repair':
            result = repair_imports(code, payload.get('context', ''))
        elif mode == 'context':
            result = filter_context(code)
        else:
            result = analyze(code)
    except SyntaxError as e:
        result = {'ok': False, 'error': 'SyntaxError: {} (line {})'.format(e.msg, e.lineno), 'functions': []}
    except RecursionError:
        result = {'ok': False, 'error': 'source too deeply nested to analyze', 'functions': []}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
