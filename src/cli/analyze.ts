import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodeAnalyzer } from '../core/analysis/analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'core', 'lang', 'python');

/** Usage: npm run analyze -- <file.py|file.cpp> — prints the static-analysis findings. */
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run analyze -- <file.py|file.cpp>');
    process.exit(2);
  }
  const language = /\.(cpp|cc|cxx|hpp|h)$/i.test(file) ? 'cpp' : 'python';
  const analyzer = new CodeAnalyzer({ scriptsDir: SCRIPTS_DIR, pythonPath: process.env.PYTHON_BIN });
  const result = await analyzer.analyze(readFileSync(file, 'utf8'), language);
  if (result.error) {
    console.error(`could not analyze: ${result.error}`);
    process.exit(1);
  }
  let total = 0;
  for (const fn of result.functions) {
    console.log(`${fn.name}  (lines ${fn.startLine + 1}-${fn.endLine + 1}, ${fn.complexity}${fn.topLevel ? '' : ', not optimizable'})`);
    for (const i of fn.issues) {
      total++;
      console.log(`  ${i.line + 1}:${i.col + 1}  [${i.severity}] ${i.kind}: ${i.message}`);
      console.log(`           -> ${i.suggestion}`);
    }
  }
  console.log(`\n${total} issue(s) in ${result.functions.length} function(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
