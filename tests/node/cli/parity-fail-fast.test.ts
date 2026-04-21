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

test('workflow command resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'workflow', 'show', '--target-root', targetDir],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'workflow show should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));
        assert.ok(combined.includes('Mandatory full-suite: false'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow set routes through the CLI dispatcher for --target-root and preserves JSON output', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-set-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-set-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--full-suite-enabled', 'true',
                '--json'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'workflow set should succeed when routed to a clean target root');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');

        const configPath = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        assert.equal(fs.existsSync(configPath), true);
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});
