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
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('gate'));
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

test('review-capabilities show resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-target-'));
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
            [CLI_PATH, 'review-capabilities', 'show', '--target-root', targetDir],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'review-capabilities show should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));
        assert.ok(combined.includes('Enabled optional reviews: none'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-help-'));
    try {
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

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'workflow', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('workflow'));
        assert.ok(combined.includes('Default mode: workflow with no subcommand behaves like workflow show.'));
        assert.ok(combined.includes('Fix'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('review-capabilities help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-help-'));
    try {
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

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'review-capabilities', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('review-capabilities'));
        assert.ok(combined.includes('Default mode: review-capabilities with no subcommand behaves like review-capabilities show.'));
        assert.ok(combined.includes('Fix'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('review-capabilities enable routes through the CLI dispatcher for --target-root and preserves JSON output', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-set-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-set-target-'));
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

        const skillRoot = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'skills', 'api-contract-review');
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# api-contract-review\n', 'utf8');

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'review-capabilities',
                'enable',
                '--target-root', targetDir,
                '--json',
                'api'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'review-capabilities enable should succeed when routed to a clean target root');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.action, 'enable');
        assert.equal(parsed.status, 'CHANGED');
        assert.deepEqual(parsed.requested_capabilities, ['api']);
        assert.equal(parsed.enabled_capabilities.includes('api'), true);

        const configPath = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json');
        assert.equal(fs.existsSync(configPath), true);
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.api, true);
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('gate subcommand help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-gate-help-'));
    try {
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

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'gate', 'enter-task-mode', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('enter-task-mode'));
        assert.ok(combined.includes('Enter explicit task mode before any implementation'));
        assert.ok(combined.includes('Usage'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
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

test('profile command resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-profile-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-profile-target-'));
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

        const profilesConfigDir = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(profilesConfigDir, { recursive: true });
        fs.writeFileSync(path.join(profilesConfigDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Default profile.',
                    depth: 2,
                    review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                    token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }, null, 2), 'utf8');

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'profile', '--target-root', targetDir, '--json'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: 5000 }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'profile should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.active_profile, 'balanced');
        assert.equal(parsed.config_path, path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});
