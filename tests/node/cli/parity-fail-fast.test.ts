import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import { EXIT_PRECONDITION_FAILURE } from '../../../src/cli/exit-codes';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        const packageJsonPath = path.join(current, 'package.json');
        const cliPath = path.join(current, 'bin', 'garda.js');
        if (fs.existsSync(packageJsonPath) && fs.existsSync(cliPath)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

const REPO_ROOT = findRepoRoot(__dirname);
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'garda.js');

test('CLI blocks task execution commands when bundle is stale', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-fail-fast-'));
    try {
        // Setup a stale source checkout layout
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');

        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        // Make bundle older
        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        // Run CLI with cwd = tmpDir
        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'gate', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE, `Expected CLI to exit with code ${EXIT_PRECONDITION_FAILURE} (PRECONDITION_FAILURE)`);
        assert.ok(
            combined.includes('Source Parity Violation: The deployed bundle is stale'),
            'Expected CLI to print parity violation message'
        );
        assert.ok(
            combined.includes('older than source launcher'),
            'Expected CLI to specify the launcher age violation'
        );

        // Non-task commands should still work (e.g. status)
        const statusResult = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'status'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );
        
        const statusCombined = (statusResult.stdout || '') + (statusResult.stderr || '');
        assert.ok(!statusCombined.includes('Source Parity Violation: The deployed bundle is stale'), 'Status command should not crash with the top-level parity throw');

    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
