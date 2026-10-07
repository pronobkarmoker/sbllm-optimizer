"""AST abstraction used by Algorithm 1 (dedup, edit distance) and by pattern retrieval.

Mirrors the reference implementation's CodeAbstractorPy: user identifiers become VAR, string
literals STR, numeric literals NUM; builtins and attribute names are kept, because they carry the
optimization technique (`set`, `sorted`, `.append`, `lru_cache`).

stdin is either raw source (single mode) or {"codes": [...]} (batch mode, one process for many
snippets — representative selection abstracts the whole pool every iteration).
"""
import sys
import ast
import json
import builtins


class Abstractor(ast.NodeTransformer):
    def __init__(self):
        self.builtin_names = set(dir(builtins))

    def _abstract_args(self, node):
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            arg.arg = 'VAR'
        if node.args.vararg:
            node.args.vararg.arg = 'VAR'
        if node.args.kwarg:
            node.args.kwarg.arg = 'VAR'

    def visit_FunctionDef(self, node):
        self._abstract_args(node)
        self.generic_visit(node)
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Lambda(self, node):
        self._abstract_args(node)
        self.generic_visit(node)
        return node

    def visit_Constant(self, node):
        self.generic_visit(node)
        if isinstance(node.value, bool) or node.value is None:
            pass
        elif isinstance(node.value, str):
            node.value = 'STR'
        elif isinstance(node.value, (int, float, complex)):
            node.value = 'NUM'
        return node

    def visit_Name(self, node):
        self.generic_visit(node)
        if node.id not in self.builtin_names:
            node.id = 'VAR'
        return node


def abstract(code):
    tree = ast.parse(code)
    return ast.unparse(Abstractor().visit(tree))


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None

    if isinstance(payload, dict) and isinstance(payload.get('codes'), list):
        out = []
        for code in payload['codes']:
            try:
                out.append(abstract(code))
            except (SyntaxError, ValueError, RecursionError):
                out.append(None)
        print(json.dumps({'ok': True, 'abstracted': out}))
        return

    try:
        print(json.dumps({'ok': True, 'abstracted': abstract(raw)}))
    except (SyntaxError, ValueError, RecursionError) as e:
        print(json.dumps({'ok': False, 'error': str(e)}))


if __name__ == '__main__':
    main()
