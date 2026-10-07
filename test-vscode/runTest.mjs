// Launches a separate VS Code instance (downloaded into .vscode-test/) with this extension loaded,
// runs suite.cjs inside its extension host, and exits with the suite's status.
import path from 'node:path';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// Inherited from a parent VS Code/Electron process, this would make the test instance start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'sbllm-vscode-test-'));
const workspace = path.join(work, 'workspace');
const userData = path.join(work, 'user-data');
cpSync(path.join(root, 'examples'), workspace, { recursive: true });

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test-vscode', 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`],
    extensionTestsEnv: { SBLLM_TEST_WORKSPACE: workspace, SBLLM_TEST_USER_DATA: userData },
  });
} catch (err) {
  console.error('VS Code integration tests failed:', err);
  process.exit(1);
}
