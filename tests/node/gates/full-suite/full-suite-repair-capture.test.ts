import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    collectTrackedChangeFiles,
    findOutOfScopeTrackedChanges,
    prepareWipCapture,
    readVerifiedCaptureFile,
    suspendPreparedWip,
    writeExclusiveCaptureFile
} from '../../../../src/gates/full-suite/full-suite-repair-capture';
import { traceGitCommands } from '../git-command-trace';

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function removeTempRoot(rootPath: string): void {
    fs.rmSync(rootPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

describe('full-suite repair capture boundary', () => {
    it('uses one bounded Git tree batch for a multi-file capture and suspension', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-batch-'));
        context.after(() => removeTempRoot(repoRoot));
        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
        runGit(repoRoot, ['config', 'user.name', 'Test User']);
        runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
        const changedFiles = Array.from({ length: 12 }, (_, index) => `src/batch file ${index}.ts`);
        for (const [index, relativePath] of changedFiles.entries()) {
            const filePath = path.join(repoRoot, relativePath);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, `export const value${index} = 1;\n`, 'utf8');
        }
        runGit(repoRoot, ['add', '.']);
        runGit(repoRoot, ['commit', '-m', 'seed batch files']);
        for (const [index, relativePath] of changedFiles.entries()) {
            fs.writeFileSync(
                path.join(repoRoot, relativePath),
                `export const value${index} = 2;\n`,
                'utf8'
            );
        }
        fs.unlinkSync(path.join(repoRoot, changedFiles[0]!));
        runGit(repoRoot, ['add', '--', changedFiles[0]!]);
        const trackedChanges = collectTrackedChangeFiles(repoRoot);
        const evidenceRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(evidenceRoot, { recursive: true });
        const preflightPath = path.join(evidenceRoot, 'T-BATCH-preflight.json');
        const fullSuiteArtifactPath = path.join(evidenceRoot, 'T-BATCH-full-suite.json');
        fs.writeFileSync(preflightPath, '{}\n', 'utf8');
        fs.writeFileSync(fullSuiteArtifactPath, '{}\n', 'utf8');

        const traced = traceGitCommands(() => {
            const prepared = prepareWipCapture({
                repoRoot,
                taskId: 'T-BATCH',
                childTaskIds: ['T-BATCH-F1'],
                childScopes: [{ task_id: 'T-BATCH-F1', paths: changedFiles }],
                captureRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip', 'T-BATCH', 'capture'),
                timestampUtc: '2026-08-03T00:00:00.000Z',
                preflightPath,
                fullSuiteArtifactPath,
                trackedChanges,
                allowedUntrackedFiles: new Set(),
                unrelatedVisibleUntrackedFiles: []
            });
            suspendPreparedWip(repoRoot, trackedChanges, prepared);
            return prepared;
        });

        assert.equal(traced.commands.some((args) => args[0] === 'ls-tree'), false);
        const treeBatchCommands = traced.commands.filter((args) => args[0] === 'cat-file');
        assert.equal(treeBatchCommands.length, 2);
        assert.ok(treeBatchCommands.some((args) => args.some((arg) => arg.startsWith('--batch-check='))));
        assert.ok(treeBatchCommands.some((args) => args.includes('--batch')));
        assert.equal(
            traced.commands.some((args) => args[0] === 'rev-parse' && args.some((arg) => arg.includes(':src/'))),
            false
        );
        assert.equal(traced.value.manifest.tracked_files.length, changedFiles.length);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '?? garda-agent-orchestrator/');
    });

    it('reports tracked paths outside the authorized preflight scope', () => {
        const trackedChanges = {
            staged: new Set(['README.md', 'src/app.ts']),
            unstaged: new Set(['src/app.ts']),
            all: ['README.md', 'src/app.ts']
        };

        assert.deepEqual(
            findOutOfScopeTrackedChanges(trackedChanges, new Set(['src/app.ts'])),
            ['README.md']
        );
    });

    it('rejects HEAD drift before suspension without mutating captured WIP', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-head-drift-'));
        context.after(() => removeTempRoot(repoRoot));
        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
        runGit(repoRoot, ['config', 'user.name', 'Test User']);
        runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
        const relativePath = 'src/drift target.ts';
        const targetPath = path.join(repoRoot, relativePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, 'export const value = 1;\n', 'utf8');
        runGit(repoRoot, ['add', '.']);
        runGit(repoRoot, ['commit', '-m', 'seed drift target']);
        fs.writeFileSync(targetPath, 'export const value = 2;\n', 'utf8');
        const trackedChanges = collectTrackedChangeFiles(repoRoot);
        const evidenceRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(evidenceRoot, { recursive: true });
        const preflightPath = path.join(evidenceRoot, 'T-DRIFT-preflight.json');
        const fullSuiteArtifactPath = path.join(evidenceRoot, 'T-DRIFT-full-suite.json');
        fs.writeFileSync(preflightPath, '{}\n', 'utf8');
        fs.writeFileSync(fullSuiteArtifactPath, '{}\n', 'utf8');
        const prepared = prepareWipCapture({
            repoRoot,
            taskId: 'T-DRIFT',
            childTaskIds: ['T-DRIFT-F1'],
            childScopes: [{ task_id: 'T-DRIFT-F1', paths: [relativePath] }],
            captureRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip', 'T-DRIFT', 'capture'),
            timestampUtc: '2026-08-03T00:00:00.000Z',
            preflightPath,
            fullSuiteArtifactPath,
            trackedChanges,
            allowedUntrackedFiles: new Set(),
            unrelatedVisibleUntrackedFiles: []
        });
        runGit(repoRoot, ['commit', '--allow-empty', '-m', 'advance HEAD after capture']);
        const statusBeforeSuspension = runGit(repoRoot, ['status', '--short']);

        assert.throws(
            () => suspendPreparedWip(repoRoot, trackedChanges, prepared),
            /repository HEAD changed during full-suite repair WIP suspension/u
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), 'export const value = 2;\n');
        assert.equal(runGit(repoRoot, ['status', '--short']), statusBeforeSuspension);
    });

    it('rejects a captured file replaced after exclusive creation', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-capture-'));
        context.after(() => removeTempRoot(repoRoot));
        const capturedPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            'T-CAPTURE',
            'full-suite-repair',
            '20260731T000000000Z',
            'staged.patch'
        );
        const originalContent = Buffer.from('original patch\n', 'utf8');
        const snapshot = writeExclusiveCaptureFile(
            repoRoot,
            capturedPath,
            originalContent,
            'captured staged WIP patch'
        );
        fs.unlinkSync(capturedPath);
        fs.writeFileSync(capturedPath, 'replacement patch with different identity\n', 'utf8');

        assert.throws(
            () => readVerifiedCaptureFile({
                repoRoot,
                filePath: capturedPath,
                label: 'captured staged WIP patch',
                expectedSha256: createHash('sha256').update(originalContent).digest('hex'),
                expectedBytes: originalContent.byteLength,
                expectedIdentity: snapshot.identity
            }),
            /captured staged WIP patch changed after exclusive creation/u
        );
    });
});
