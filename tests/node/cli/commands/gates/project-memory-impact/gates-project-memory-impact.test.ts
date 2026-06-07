import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    PROJECT_MEMORY_MAP_WRITE_CONTRACT,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES
} from '../../../../../../src/core/project-memory';
import { runCliWithCapturedOutput } from '../../gate-test-cli-capture';

function createTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-pm-impact-cli-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const sourceRoot = path.resolve(process.cwd());
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: '0.0.0-test'
    }, null, 2), 'utf8');
    fs.writeFileSync(
        path.join(bundleRoot, 'bin', 'garda.js'),
        [
            '#!/usr/bin/env node',
            "const childProcess = require('node:child_process');",
            `const cliPath = ${JSON.stringify(path.join(sourceRoot, 'bin', 'garda.js'))};`,
            "const result = childProcess.spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {",
            "  cwd: process.cwd(),",
            "  stdio: 'inherit'",
            '});',
            "if (typeof result.status === 'number') {",
            '  process.exit(result.status);',
            '}',
            'process.exit(1);',
            ''
        ].join('\n'),
        'utf8'
    );
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nDurable content for ${fileName}.\n`, 'utf8');
    }
    return repoRoot;
}

function initializeGitRepo(repoRoot: string): void {
    childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'garda-tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Garda Tests'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoRoot, stdio: 'ignore' });
}

function writePreflight(repoRoot: string, taskId: string, changedFiles: string[]): string {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId, changed_files: changedFiles }, null, 2), 'utf8');
    return preflightPath;
}

function extractRemediationCommand(output: string): string {
    const remediationLine = output
        .split(/\r?\n/)
        .find((line) => line.startsWith('RemediationCommand: '));
    assert.ok(remediationLine, 'Expected RemediationCommand in CLI output.');
    return remediationLine.slice('RemediationCommand: '.length).trim();
}

test('project-memory-impact CLI writes advisory impact artifact', async () => {
    const repoRoot = createTempRepo();
    try {
        const result = await runCliWithCapturedOutput([
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-200',
            '--mode',
            'check',
            '--changed-file',
            'src/cli/commands/gate-command.ts',
            '--repo-root',
            repoRoot
        ]);

        assert.equal(result.exitCode, 0);
        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-200-impact.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.status, 'UPDATE_NEEDED');
        assert.equal(artifact.writes_allowed, false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI prints a ready-to-run remediation command when affected memory files must be confirmed', async () => {
    const repoRoot = createTempRepo();
    try {
        const result = await runCliWithCapturedOutput([
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-200A',
            '--mode',
            'strict',
            '--changed-file',
            'src/gates/project-memory-impact.ts',
            '--repo-root',
            repoRoot
        ]);

        assert.equal(result.exitCode, 3);
        const output = result.logs.join('\n');
        const remediationCommand = extractRemediationCommand(output);
        assert.match(output, /RemediationCommand: .*gate project-memory-impact/);
        assert.match(output, /--mode "strict"/);
        assert.match(output, /--changed-file "src\/gates\/project-memory-impact\.ts"/);
        assert.match(output, /--confirm-updated/);
        assert.doesNotMatch(output, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);
        assert.match(output, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);
        assert.match(output, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);
        assert.match(output, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/decisions\.md"/);
        assert.match(output, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/risks\.md"/);
        assert.match(output, /--skip-unchanged-candidates-rationale /);
        assert.match(output, /MemoryWriteContract:/);
        assert.ok(output.includes(PROJECT_MEMORY_MAP_WRITE_CONTRACT));

        const rerun = childProcess.spawnSync(remediationCommand, {
            cwd: repoRoot,
            shell: true,
            encoding: 'utf8'
        });
        assert.equal(rerun.status, 0, `Remediation command failed.\nSTDOUT:\n${rerun.stdout}\nSTDERR:\n${rerun.stderr}`);
        const updatePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-200A-update.json');
        const update = JSON.parse(fs.readFileSync(updatePath, 'utf8')) as Record<string, unknown>;
        assert.equal(update.status, 'UPDATED');
        assert.deepEqual(update.updated_memory_files, []);
        assert.deepEqual(update.skipped_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/commands.md',
            'garda-agent-orchestrator/live/docs/project-memory/compact.md',
            'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
            'garda-agent-orchestrator/live/docs/project-memory/risks.md'
        ]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI accepts confirmed update evidence', async () => {
    const repoRoot = createTempRepo();
    try {
        const baseArgs = [
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-201',
            '--mode',
            'strict',
            '--changed-file',
            'src/gates/project-memory-impact.ts',
            '--repo-root',
            repoRoot
        ];
        const first = await runCliWithCapturedOutput(baseArgs);
        assert.equal(first.exitCode, 3);

        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        const confirmed = await runCliWithCapturedOutput([
            ...baseArgs,
            '--confirm-updated',
            '--updated-memory-file',
            path.join(memoryRoot, 'commands.md'),
            '--updated-memory-file',
            path.join(memoryRoot, 'compact.md'),
            '--updated-memory-file',
            path.join(memoryRoot, 'decisions.md'),
            '--updated-memory-file',
            path.join(memoryRoot, 'risks.md')
        ]);

        assert.equal(confirmed.exitCode, 0);
        const updatePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-201-update.json');
        const update = JSON.parse(fs.readFileSync(updatePath, 'utf8')) as Record<string, unknown>;
        assert.equal(update.status, 'UPDATED');
        assert.equal((update.updated_memory_files as unknown[]).length, 4);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI accepts partial update evidence with skipped candidate rationale', async () => {
    const repoRoot = createTempRepo();
    try {
        const baseArgs = [
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-201P',
            '--mode',
            'strict',
            '--changed-file',
            'src/gates/project-memory-impact.ts',
            '--repo-root',
            repoRoot
        ];
        const first = await runCliWithCapturedOutput(baseArgs);
        assert.equal(first.exitCode, 3);

        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        fs.appendFileSync(path.join(memoryRoot, 'commands.md'), '\nCurrent command guidance changed.\n', 'utf8');
        const confirmed = await runCliWithCapturedOutput([
            ...baseArgs,
            '--confirm-updated',
            '--updated-memory-file',
            path.join(memoryRoot, 'commands.md'),
            '--skip-unchanged-candidates-rationale',
            'Other candidate memory files already describe the current durable contracts; only command guidance changed.'
        ]);

        assert.equal(confirmed.exitCode, 0);
        const updatePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-201P-update.json');
        const update = JSON.parse(fs.readFileSync(updatePath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(update.updated_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ]);
        assert.deepEqual(update.skipped_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/compact.md',
            'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
            'garda-agent-orchestrator/live/docs/project-memory/risks.md'
        ]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI infers updated memory files when the current project-memory diff exactly matches the affected set', async () => {
    const repoRoot = createTempRepo();
    try {
        initializeGitRepo(repoRoot);
        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        for (const fileName of ['commands.md', 'compact.md', 'decisions.md', 'risks.md']) {
            fs.appendFileSync(path.join(memoryRoot, fileName), '\nUpdated for inference.\n', 'utf8');
        }

        const result = await runCliWithCapturedOutput([
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-201A',
            '--mode',
            'strict',
            '--changed-file',
            'src/gates/project-memory-impact.ts',
            '--confirm-updated',
            '--repo-root',
            repoRoot
        ]);

        assert.equal(result.exitCode, 0);
        const updatePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-201A-update.json');
        const update = JSON.parse(fs.readFileSync(updatePath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(update.updated_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/commands.md',
            'garda-agent-orchestrator/live/docs/project-memory/compact.md',
            'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
            'garda-agent-orchestrator/live/docs/project-memory/risks.md'
        ]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI rejects incomplete explicit updated-memory-file evidence', async () => {
    const repoRoot = createTempRepo();
    try {
        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        const result = await runCliWithCapturedOutput([
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-201B',
            '--mode',
            'strict',
            '--changed-file',
            'src/gates/project-memory-impact.ts',
            '--confirm-updated',
            '--updated-memory-file',
            path.join(memoryRoot, 'commands.md'),
            '--updated-memory-file',
            path.join(memoryRoot, 'compact.md'),
            '--repo-root',
            repoRoot
        ]);

        assert.equal(result.exitCode, 3);
        const output = result.logs.join('\n');
        assert.match(output, /Confirmed update evidence does not account for affected memory files/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('project-memory-impact CLI uses preflight changes when changed-file flags are absent', async () => {
    const repoRoot = createTempRepo();
    try {
        const preflightPath = writePreflight(repoRoot, 'T-202', ['src/gates/project-memory-impact.ts']);
        const result = await runCliWithCapturedOutput([
            'gate',
            'project-memory-impact',
            '--task-id',
            'T-202',
            '--mode',
            'check',
            '--preflight-path',
            preflightPath,
            '--repo-root',
            repoRoot
        ]);

        assert.equal(result.exitCode, 0);
        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory', 'T-202-impact.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
            status: string;
            changed_files: string[];
            affected_memory_file_names: string[];
        };
        assert.equal(artifact.status, 'UPDATE_NEEDED');
        assert.deepEqual(artifact.changed_files, ['src/gates/project-memory-impact.ts']);
        assert.ok(artifact.affected_memory_file_names.includes('risks.md'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
