"""Mine an optimization-pattern base from the PIE dataset (paper §II-C, "Fine-grained Pattern Parsing").

The paper builds its pattern base from PIE's training split (36,857 Python / 77,967 C++ slow->fast
pairs). This script turns such a split into the JSON format the extension reads via the
`sbllmOptimizer.patternFile` setting:

    python scripts/mine_patterns.py train.jsonl --lang python --out patterns-python.json

Input: JSON Lines (or a JSON array) of pairs. Recognized field names, in order of preference:
  slow:  slow | query | src_code | input | code_v0_no_empty_lines | code_v0
  fast:  fast | reference | tgt_code | target | code_v1_no_empty_lines | code_v1
(PIE: https://github.com/madaan/pie-perf; SBLLM processed data: https://zenodo.org/records/14096664)

For Python, abstractions (s_a, f_a) are precomputed with the same abstractor the extension uses, so
the extension doesn't have to abstract tens of thousands of snippets at load time. For C++ the
extension abstracts in-process, so only the raw pair is stored.

Pairs are kept only when they parse (Python), fit within --max-lines, and actually change something
after abstraction; pairs with an identical abstracted edit are deduplicated.
"""
import argparse
import difflib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src', 'core', 'lang', 'python'))
from abstract import abstract as abstract_py  # noqa: E402

SLOW_KEYS = ['slow', 'query', 'src_code', 'input', 'code_v0_no_empty_lines', 'code_v0']
FAST_KEYS = ['fast', 'reference', 'tgt_code', 'target', 'code_v1_no_empty_lines', 'code_v1']


def pick(obj, keys):
    for k in keys:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def read_rows(path):
    with open(path, encoding='utf-8') as f:
        head = f.read(1)
        f.seek(0)
        if head == '[':
            yield from json.load(f)
            return
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def abstract_cpp_light(code):
    """Only used for dedup keys of C++ pairs (the extension does the real abstraction)."""
    code = re.sub(r'/\*.*?\*/|//[^\n]*', ' ', code, flags=re.S)
    code = re.sub(r'"(?:\\.|[^"\\\n])*"', '"STR"', code)
    code = re.sub(r'\b\d+(\.\d+)?\b', 'NUM', code)
    return '\n'.join(l.strip() for l in code.split('\n') if l.strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='PIE-style JSONL/JSON file of slow->fast pairs')
    ap.add_argument('--lang', choices=['python', 'cpp'], required=True)
    ap.add_argument('--out', required=True, help='output JSON file')
    ap.add_argument('--max-lines', type=int, default=60, help='skip pairs longer than this (default 60)')
    ap.add_argument('--limit', type=int, default=0, help='stop after this many patterns (0 = no limit)')
    args = ap.parse_args()

    out, seen = [], set()
    total = skipped = 0
    for i, row in enumerate(read_rows(args.input)):
        total += 1
        slow, fast = pick(row, SLOW_KEYS), pick(row, FAST_KEYS)
        if not slow or not fast or slow.strip() == fast.strip():
            skipped += 1
            continue
        if max(slow.count('\n'), fast.count('\n')) + 1 > args.max_lines:
            skipped += 1
            continue
        entry = {'id': str(row.get('id') or row.get('problem_id') or 'pie-{}'.format(i)), 'lang': args.lang,
                 'slow': slow, 'fast': fast}
        try:
            if args.lang == 'python':
                sa, fa = abstract_py(slow), abstract_py(fast)
                entry['slowAbs'], entry['fastAbs'] = sa, fa
            else:
                sa, fa = abstract_cpp_light(slow), abstract_cpp_light(fast)
        except (SyntaxError, ValueError, RecursionError):
            skipped += 1
            continue
        diff = [l for l in difflib.ndiff(sa.split('\n'), fa.split('\n')) if l[:2] in ('- ', '+ ')]
        key = '\n'.join(diff)
        if not diff or key in seen:
            skipped += 1
            continue
        seen.add(key)
        out.append(entry)
        if args.limit and len(out) >= args.limit:
            break

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f)
    print('read {} pairs, kept {} patterns, skipped {} -> {}'.format(total, len(out), skipped, args.out))


if __name__ == '__main__':
    main()
