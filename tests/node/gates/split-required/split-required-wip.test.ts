import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    captureAndSuspendSplitRequiredWip,
    listSplitRequiredWip,
    restoreSplitRequiredWip,
    retireSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import {
    materializeSplitRequiredLatch
} from '../../../../src/gates/next-step/next-step-split-required-latch';
import {
    resolveSplitRequiredTaskQueueRoute
} from '../../../../src/gates/next-step/next-step-terminal-status-routing';
import {
    runCliWithCapturedOutput
} from '../../cli/commands/gate-test-cli-capture';

const TASK_ID = 'T-WIP-1';

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string | Buffer): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function readFile(repoRoot: string, relativePath: string): string {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readBuffer(repoRoot: string, relativePath: string): Buffer {
    return fs.readFileSync(path.join(repoRoot, relativePath));
}

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-split-wip-'));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', [
        'garda-agent-orchestrator/runtime/',
        ''
    ].join('\n'));
    writeFile(repoRoot, 'TASK.md', [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Parent | gpt-5.5 | 2026-06-30 | strict | Split parent. |`,
        ''
    ].join('\n'));
    writeFile(repoRoot, 'src/a.ts', 'export const a = 1;\n');
    writeFile(repoRoot, 'src/b.ts', 'export const b = 1;\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function writePreflight(repoRoot: string, changedFiles: string[]): string {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify({
        task_id: TASK_ID,
        changed_files: changedFiles,
        required_reviews: {},
        metrics: {
            changed_files_count: changedFiles.length,
            changed_lines_total: changedFiles.length
        }
    }, null, 2)}\n`, 'utf8');
    return preflightPath;
}

function capture(repoRoot: string, changedFiles: string[]) {
    const preflightPath = writePreflight(repoRoot, changedFiles);
    return captureAndSuspendSplitRequiredWip({
        repoRoot,
        taskId: TASK_ID,
        preflightPath,
        guardKind: 'scope_budget',
        guardReason: 'test split-required guard'
    });
}

describe('split-required WIP capture and restore', () => {
    it('captures WIP when ordinary split-required latch materializes in a git worktree', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const preflightPath = writePreflight(repoRoot, ['src/a.ts']);

        const latch = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
            reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
            taskId: TASK_ID,
            guardKind: 'scope_budget',
            guardReason: 'scope was too large',
            rawGuardSummary: 'scope budget guard',
            preflightPath,
            guardDetails: {}
        });

        assert.equal(latch.status_sync.outcome, 'updated');
        assert.equal(latch.wip_capture?.status, 'CAPTURED');
        assert.ok(latch.wip_capture?.manifest_path);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        const splitArtifact = JSON.parse(fs.readFileSync(latch.artifact_path, 'utf8')) as Record<string, unknown>;
        const wipCapture = splitArtifact.wip_capture as Record<string, unknown>;
        assert.equal(wipCapture.status, 'CAPTURED');
        assert.ok((splitArtifact.next_actions as string[]).includes('preview_or_restore_selected_wip_in_child_task'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | SPLIT_REQUIRED |`));
    });

    it('captures tracked and task-owned untracked files, suspends the worktree, and restores all files explicitly', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        writeFile(repoRoot, `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`, '{"task":true}\n');
        writeFile(repoRoot, `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`, '{"ignored":true}\n');

        const captured = capture(repoRoot, ['src/a.ts', 'src/new.ts', `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`]);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.deepEqual(captured.tracked_files, ['src/a.ts']);
        assert.deepEqual(captured.untracked_files.sort(), [
            `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`,
            'src/new.ts'
        ]);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);
        assert.equal(fs.existsSync(path.join(repoRoot, `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`)), false);

        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.kind, 'split_required_wip');
        assert.equal((manifest.ignored_runtime_artifacts as string[]).includes(`garda-agent-orchestrator/runtime/reviews/${TASK_ID}-scratch.json`), true);
        assert.ok((manifest.restore_commands as Record<string, string>).preview_partial_template.includes('restore-split-required-wip'));

        const listed = listSplitRequiredWip({ repoRoot, taskId: TASK_ID });
        assert.equal(listed.status, 'FOUND');
        assert.equal(listed.manifests.length, 1);

        const dryRun = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            dryRun: true
        });
        assert.equal(dryRun.status, 'DRY_RUN_OK');
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files.sort(), [
            `garda-agent-orchestrator/runtime/tmp/${TASK_ID}/notes.json`,
            'src/a.ts',
            'src/new.ts'
        ]);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(readFile(repoRoot, 'src/new.ts'), 'export const added = true;\n');
    });

    it('restores only selected paths and leaves the remaining captured files suspended', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/b.ts', 'export const b = 2;\n');

        const captured = capture(repoRoot, ['src/a.ts', 'src/b.ts']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/a.ts']);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(readFile(repoRoot, 'src/b.ts'), 'export const b = 1;\n');
    });

    it('round-trips staged tracked changes and preserves index state on restore', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);

        const captured = capture(repoRoot, ['src/a.ts']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), '');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['src/a.ts']);
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), 'src/a.ts');
    });

    it('round-trips tracked binary patches byte-for-byte', () => {
        const repoRoot = makeRepo();
        const original = Buffer.from([0, 1, 2, 3, 4, 255]);
        const updated = Buffer.from([0, 1, 9, 8, 7, 6, 255, 0]);
        writeFile(repoRoot, 'assets/blob.bin', original);
        runGit(repoRoot, ['add', 'assets/blob.bin']);
        runGit(repoRoot, ['commit', '-m', 'add binary asset']);
        writeFile(repoRoot, 'assets/blob.bin', updated);

        const captured = capture(repoRoot, ['assets/blob.bin']);
        assert.equal(captured.status, 'CAPTURED');
        assert.ok(captured.manifest_path);
        assert.deepEqual(readBuffer(repoRoot, 'assets/blob.bin'), original);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.deepEqual(restored.restored_files, ['assets/blob.bin']);
        assert.deepEqual(readBuffer(repoRoot, 'assets/blob.bin'), updated);
    });

    it('blocks restore on stale base or overlapping child edits', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'child work']);
        const stale = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(stale.status, 'BLOCKED');
        assert.ok(stale.violations.some((violation) => violation.includes('stale base commit')));

        runGit(repoRoot, ['reset', '--hard', 'HEAD~1']);
        writeFile(repoRoot, 'src/a.ts', 'export const childOverlap = true;\n');
        const overlap = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });
        assert.equal(overlap.status, 'BLOCKED');
        assert.ok(overlap.violations.some((violation) => violation.includes('unstaged tracked changes exist')));
    });

    it('blocks capture when unrelated untracked files would leak into child scope', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'scratch.txt', 'unrelated\n');

        const captured = capture(repoRoot, ['src/a.ts']);
        assert.equal(captured.status, 'BLOCKED');
        assert.ok(captured.violations.some((violation) => violation.includes('unrelated untracked files')));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 2;\n');
    });

    it('retires a captured manifest without deleting the evidence files', () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        const captured = capture(repoRoot, ['src/a.ts']);
        assert.ok(captured.manifest_path);

        const retired = retireSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            reason: 'child scopes no longer need this WIP'
        });
        assert.equal(retired.status, 'RETIRED');
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as Record<string, unknown>;
        assert.equal(manifest.status, 'retired');
        assert.equal(manifest.retired_reason, 'child scopes no longer need this WIP');
        assert.equal(fs.existsSync(path.join(path.dirname(captured.manifest_path), 'unstaged.patch')), true);
    });

    it('dispatches public split-required WIP gate commands with output and exit codes', async () => {
        const repoRoot = makeRepo();
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        writeFile(repoRoot, 'src/new.ts', 'export const added = true;\n');
        const captured = capture(repoRoot, ['src/a.ts', 'src/new.ts']);
        assert.ok(captured.manifest_path);

        const listed = await runCliWithCapturedOutput([
            'gate',
            'list-split-required-wip',
            '--task-id',
            TASK_ID,
            '--repo-root',
            repoRoot
        ]);
        assert.equal(listed.exitCode, 0);
        assert.ok(listed.logs.includes('SPLIT_REQUIRED_WIP_FOUND'));
        assert.ok(listed.logs.includes('ManifestCount: 1'));
        assert.ok(listed.logs.some((line) => line.startsWith('ManifestPath: ')));

        const preview = await runCliWithCapturedOutput([
            'gate',
            'restore-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            captured.manifest_path,
            '--include-paths',
            'src/a.ts,src/new.ts',
            '--dry-run',
            '--repo-root',
            repoRoot
        ]);
        assert.equal(preview.exitCode, 0);
        assert.ok(preview.logs.includes('SPLIT_REQUIRED_WIP_RESTORE_DRY_RUN_OK'));
        assert.ok(preview.logs.includes('SelectedPaths: src/a.ts, src/new.ts'));
        assert.equal(readFile(repoRoot, 'src/a.ts'), 'export const a = 1;\n');
        assert.equal(fs.existsSync(path.join(repoRoot, 'src/new.ts')), false);

        const blocked = await runCliWithCapturedOutput([
            'gate',
            'restore-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            '../outside-manifest.json',
            '--repo-root',
            repoRoot
        ]);
        assert.notEqual(blocked.exitCode, 0);
        assert.ok(blocked.logs.includes('SPLIT_REQUIRED_WIP_RESTORE_BLOCKED'));
        assert.ok(blocked.logs.some((line) => line.includes('ManifestPath escapes repo root')));

        const retired = await runCliWithCapturedOutput([
            'gate',
            'retire-split-required-wip',
            '--task-id',
            TASK_ID,
            '--manifest-path',
            captured.manifest_path,
            '--reason',
            'child task restored selected files',
            '--repo-root',
            repoRoot
        ]);
        assert.equal(retired.exitCode, 0);
        assert.ok(retired.logs.includes('SPLIT_REQUIRED_WIP_RETIRED'));
        assert.ok(retired.logs.includes('Reason: child task restored selected files'));
    });

    it('surfaces split-required WIP list and explicit restore guidance in terminal routing', () => {
        const route = resolveSplitRequiredTaskQueueRoute({
            taskId: TASK_ID,
            latchValid: true,
            latchInvalidReason: '',
            hasChildren: false,
            transitionResult: null,
            childRoute: null,
            continueChildCommand: null
        });

        assert.equal(route.status, 'SPLIT_REQUIRED');
        assert.equal(route.nextGate, 'split-required-latch');
        assert.ok(route.reason.includes('node bin/garda.js gate list-split-required-wip'));
        assert.ok(route.reason.includes(`--task-id \\\"${TASK_ID}\\\"`));
        assert.ok(route.reason.includes('--repo-root \\\".\\\"'));
        assert.ok(route.reason.includes('restore only by explicit preview/apply commands in child scope'));
    });
});
