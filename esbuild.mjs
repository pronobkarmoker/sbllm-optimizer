import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');

function copyPythonScripts() {
  const srcDir = path.join('src', 'core', 'lang', 'python');
  const outDir = path.join('dist', 'python');
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    if (file.endsWith('.py')) {
      copyFileSync(path.join(srcDir, file), path.join(outDir, file));
    }
  }
  console.log(`[build] copied python scripts -> ${outDir}`);
}

const buildOptions = {
  entryPoints: ['src/vscode/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

copyPythonScripts();

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[build] watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('[build] done.');
}
