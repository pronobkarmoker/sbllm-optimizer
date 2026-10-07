// Runs every test/*.test.ts with tsx's node:test integration. Node 18's `--test` doesn't expand
// globs and Windows shells don't either, so the file list is built here.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join('test', f));

const tsx = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const res = spawnSync(process.execPath, [tsx, '--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
