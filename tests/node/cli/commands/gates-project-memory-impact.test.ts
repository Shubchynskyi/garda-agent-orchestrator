import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    PROJECT_MEMORY_REQUIRED_FILE_NAMES
} from '../../../../src/core/project-memory';
import { runCliWithCapturedOutput } from './gate-test-cli-capture';

function createTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-pm-impact-cli-'));
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nDurable content for ${fileName}.\n`, 'utf8');
    }
    return repoRoot;
}

function writePreflight(repoRoot: string, taskId: string, changedFiles: string[]): string {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId, changed_files: changedFiles }, null, 2), 'utf8');
    return preflightPath;
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
