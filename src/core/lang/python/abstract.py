import sys
import ast
import json
import builtins


class Abstractor(ast.NodeTransformer):
    def __init__(self):
        self.builtin_names = set(dir(builtins))

    def visit_FunctionDef(self, node):
        for arg in node.args.args:
            arg.arg = 'VAR'
        self.generic_visit(node)
        return node

    def visit_Constant(self, node):
        self.generic_visit(node)
        if isinstance(node.value, bool):
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


def main():
    code = sys.stdin.read()
    try:
        tree = ast.parse(code)
        abstracted = Abstractor().visit(tree)
        print(json.dumps({'ok': True, 'abstracted': ast.unparse(abstracted)}))
    except SyntaxError as e:
        print(json.dumps({'ok': False, 'error': str(e)}))


if __name__ == '__main__':
    main()
