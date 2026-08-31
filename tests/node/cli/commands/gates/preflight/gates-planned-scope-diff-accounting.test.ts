import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildBudgetForecast } from '../../../../../../src/gate-runtime/budget-preflight';
import { getPreflightContext, getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import { getCompileScopeDriftViolations } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-scope-guards';
import { buildDomainScopeFingerprints } from '../../../../../../src/gates/scope/domain-scope-fingerprints';
import { readPreflightWorkspaceReadiness } from '../../../../../../src/gates/next-step/next-step-preflight-workspace-readiness';
import {
    createTempRepo as createGateTempRepo,
    initializeGitRepo
} from '../../gate-test-repo-bootstrap';
import {
    loadTaskEntryRulePack,
    runClassifyChangeCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue
} from '../../gate-test-seed-helpers';

function writeLines(filePath: string, count: number, prefix: string): void {
    const content = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join('\n');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function runGit(repoRoot: string, args: string[]): void {
    execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}

function createRepo(): { tempRoot: string; repoRoot: string } {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-planned-diff-'));
    const repoRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Test']);
    runGit(repoRoot, ['config', 'user.email', 'garda@example.test']);
    return { tempRoot, repoRoot };
}

function commitAll(repoRoot: string): void {
    runGit(repoRoot, ['add', '--all']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);
}

function runWithRepoCwd<T>(repoRoot: string, callback: () => T): T {
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
        return callback();
    } finally {
        process.chdir(previousCwd);
    }
}

describe('planned-scope diff accounting', { concurrency: false }, () => {
    let tempRoot: string;
    let repoRoot: string;

    beforeEach(() => {
        ({ tempRoot, repoRoot } = createRepo());
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('keeps an unchanged tracked planned file authorized without inventing a diff', () => {
        writeLines(path.join(repoRoot, 'src', 'planned.ts'), 12, 'planned');
        writeLines(path.join(repoRoot, 'src', 'other-planned.ts'), 8, 'other');
        commitAll(repoRoot);

        const snapshot = getWorkspaceSnapshot(
            repoRoot,
            'explicit_changed_files',
            true,
            ['src/planned.ts']
        );

        assert.deepEqual(snapshot.authorized_files, ['src/planned.ts']);
        assert.deepEqual(snapshot.changed_files, []);
        assert.deepEqual(snapshot.changed_file_stats, {});
        assert.equal(snapshot.changed_files_count, 0);
        assert.equal(snapshot.changed_lines_total, 0);
        assert.equal(snapshot.additions_total, 0);
        assert.equal(snapshot.deletions_total, 0);

        const readiness = readPreflightWorkspaceReadiness(repoRoot, {
            detection_source: snapshot.detection_source,
            changed_files: snapshot.changed_files,
            authorized_files: snapshot.authorized_files,
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                actual_changed_files: snapshot.changed_files,
                actual_changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256,
                domain_scope_fingerprints: buildDomainScopeFingerprints({
                    repoRoot,
                    detectionSource: snapshot.detection_source,
                    includeUntracked: snapshot.include_untracked,
                    changedFiles: snapshot.changed_files
                })
            }
        }, {
            plannedChangedFiles: snapshot.authorized_files
        });
        assert.equal(readiness.ready, true, readiness.reason);

        const preflightPath = path.join(repoRoot, 'preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-979-21-F5-fixture',
            detection_source: snapshot.detection_source,
            changed_files: snapshot.changed_files,
            authorized_files: snapshot.authorized_files,
            required_reviews: { code: true },
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                actual_changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            }
        }), 'utf8');
        const preflightContext = getPreflightContext(preflightPath, 'T-979-21-F5-fixture');
        const compileSnapshot = getWorkspaceSnapshot(
            repoRoot,
            preflightContext.detection_source,
            preflightContext.include_untracked,
            preflightContext.authorized_files
        );
        assert.deepEqual(preflightContext.authorized_files, ['src/planned.ts']);
        assert.deepEqual(compileSnapshot.changed_files, []);
        assert.deepEqual(getCompileScopeDriftViolations({
            preflightContext,
            workspaceSnapshot: compileSnapshot
        }), []);

        const otherAuthorization = getWorkspaceSnapshot(
            repoRoot,
            'explicit_changed_files',
            true,
            ['src/other-planned.ts']
        );
        assert.deepEqual(otherAuthorization.changed_files, []);
        assert.equal(otherAuthorization.changed_files_sha256, snapshot.changed_files_sha256);
        assert.notEqual(otherAuthorization.authorized_files_sha256, snapshot.authorized_files_sha256);
        assert.notEqual(otherAuthorization.scope_sha256, snapshot.scope_sha256);
    });

    it('reports only the bounded tracked delta for a small planned edit', () => {
        writeLines(path.join(repoRoot, 'src', 'planned.ts'), 20, 'before');
        commitAll(repoRoot);
        const filePath = path.join(repoRoot, 'src', 'planned.ts');
        const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n');
        lines[9] = 'after-10';
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const snapshot = getWorkspaceSnapshot(
            repoRoot,
            'explicit_changed_files',
            true,
            ['src/planned.ts']
        );

        assert.deepEqual(snapshot.authorized_files, ['src/planned.ts']);
        assert.deepEqual(snapshot.changed_files, ['src/planned.ts']);
        assert.deepEqual(snapshot.changed_file_stats['src/planned.ts'], {
            additions: 1,
            deletions: 1,
            changed_lines: 2
        });
        assert.equal(snapshot.changed_lines_total, 2);
    });

    it('reproduces the 2216-versus-69 inflation case and keeps budget and domain scope actual', () => {
        writeLines(path.join(repoRoot, 'src', 'large-planned.ts'), 2216, 'large');
        commitAll(repoRoot);
        writeLines(path.join(repoRoot, 'src', 'new-task-file.ts'), 69, 'new');

        const snapshot = getWorkspaceSnapshot(
            repoRoot,
            'explicit_changed_files',
            true,
            ['src/large-planned.ts', 'src/new-task-file.ts']
        );
        const domainFingerprints = buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: snapshot.detection_source,
            includeUntracked: snapshot.include_untracked,
            changedFiles: snapshot.changed_files
        });
        const budget = buildBudgetForecast({
            taskId: 'T-979-21-F5-fixture',
            requestedDepth: 2,
            effectiveDepth: 3,
            pathMode: 'FULL_PATH',
            changedFilesCount: snapshot.changed_files_count,
            changedLinesTotal: snapshot.changed_lines_total,
            requiredReviews: { code: true, security: true, test: true }
        });

        assert.deepEqual(snapshot.authorized_files, [
            'src/large-planned.ts',
            'src/new-task-file.ts'
        ]);
        assert.deepEqual(snapshot.changed_files, ['src/new-task-file.ts']);
        assert.equal(snapshot.changed_lines_total, 69);
        assert.equal(snapshot.additions_total, 69);
        assert.equal(domainFingerprints.domains.implementation.changed_files_count, 1);
        assert.deepEqual(domainFingerprints.domains.implementation.changed_files, [
            'src/new-task-file.ts'
        ]);
        assert.equal(budget.changed_files_count, 1);
        assert.equal(budget.changed_lines_total, 69);

        const readiness = readPreflightWorkspaceReadiness(repoRoot, {
            detection_source: snapshot.detection_source,
            changed_files: snapshot.changed_files,
            authorized_files: snapshot.authorized_files,
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.authorized_files_sha256,
                actual_changed_files: snapshot.changed_files,
                actual_changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256,
                domain_scope_fingerprints: domainFingerprints
            }
        }, {
            plannedChangedFiles: snapshot.authorized_files
        });
        assert.equal(readiness.ready, true, readiness.reason);
    });

    it('emits authorized scope and actual diff accounting through classify-change', () => {
        const commandRepoRoot = createGateTempRepo();
        const taskId = 'T-979-21-F5-command-contract';
        try {
            fs.writeFileSync(
                path.join(commandRepoRoot, '.gitignore'),
                'TASK.md\ngarda-agent-orchestrator/runtime/\n',
                'utf8'
            );
            fs.writeFileSync(path.join(commandRepoRoot, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
            writeLines(path.join(commandRepoRoot, 'src', 'large-planned.ts'), 2216, 'large');
            initializeGitRepo(commandRepoRoot);
            seedTaskQueue(commandRepoRoot, taskId);
            seedInitAnswers(commandRepoRoot);

            runWithRepoCwd(commandRepoRoot, () => {
                runEnterTaskMode({
                    repoRoot: commandRepoRoot,
                    taskId,
                    taskSummary: 'Separate planned authorization from actual diff accounting'
                });
                loadTaskEntryRulePack(commandRepoRoot, taskId);
                runHandshakeForTask(commandRepoRoot, taskId);
                runShellSmokeForTask(commandRepoRoot, taskId);
            });

            writeLines(path.join(commandRepoRoot, 'src', 'new-task-file.ts'), 69, 'new');
            const outputPath = path.join(
                commandRepoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'reviews',
                `${taskId}-preflight.json`
            );
            const result = runWithRepoCwd(commandRepoRoot, () => runClassifyChangeCommand({
                repoRoot: commandRepoRoot,
                taskId,
                taskIntent: 'Separate planned authorization from actual diff accounting',
                changedFiles: ['src/large-planned.ts', 'src/new-task-file.ts'],
                outputPath,
                emitMetrics: false
            }));
            const payload = JSON.parse(result.outputText);

            assert.deepEqual(payload.authorized_files, [
                'src/large-planned.ts',
                'src/new-task-file.ts'
            ]);
            assert.deepEqual(payload.changed_files, ['src/new-task-file.ts']);
            assert.equal(payload.metrics.authorized_files_count, 2);
            assert.equal(payload.metrics.changed_files_count, 1);
            assert.deepEqual(payload.metrics.actual_changed_files, ['src/new-task-file.ts']);
            assert.equal(payload.metrics.actual_changed_files_count, 1);
            assert.equal(payload.metrics.changed_lines_total, 69);
            assert.deepEqual(
                payload.metrics.domain_scope_fingerprints.domains.implementation.changed_files,
                ['src/new-task-file.ts']
            );
            assert.equal(payload.budget_forecast.changed_files_count, 1);
            assert.equal(payload.budget_forecast.changed_lines_total, 69);
        } finally {
            fs.rmSync(commandRepoRoot, { recursive: true, force: true });
        }
    });

    it('keeps unchanged authorized scope baseline-only through classify-change', () => {
        const commandRepoRoot = createGateTempRepo();
        const taskId = 'T-979-21-F5-unchanged-command-contract';
        try {
            fs.writeFileSync(
                path.join(commandRepoRoot, '.gitignore'),
                'TASK.md\ngarda-agent-orchestrator/runtime/\n',
                'utf8'
            );
            fs.writeFileSync(path.join(commandRepoRoot, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
            writeLines(path.join(commandRepoRoot, 'project', 'planned.ts'), 4, 'planned');
            initializeGitRepo(commandRepoRoot);
            seedTaskQueue(commandRepoRoot, taskId);
            seedInitAnswers(commandRepoRoot);

            runWithRepoCwd(commandRepoRoot, () => {
                runEnterTaskMode({
                    repoRoot: commandRepoRoot,
                    taskId,
                    taskSummary: 'Keep unchanged planned scope baseline-only'
                });
                loadTaskEntryRulePack(commandRepoRoot, taskId);
                runHandshakeForTask(commandRepoRoot, taskId);
                runShellSmokeForTask(commandRepoRoot, taskId);
            });

            const outputPath = path.join(
                commandRepoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'reviews',
                `${taskId}-preflight.json`
            );
            const result = runWithRepoCwd(commandRepoRoot, () => runClassifyChangeCommand({
                repoRoot: commandRepoRoot,
                taskId,
                taskIntent: 'Keep unchanged planned scope baseline-only',
                changedFiles: ['project/planned.ts'],
                outputPath,
                emitMetrics: false
            }));
            const payload = JSON.parse(result.outputText);

            assert.deepEqual(payload.authorized_files, ['project/planned.ts']);
            assert.deepEqual(payload.changed_files, []);
            assert.equal(payload.zero_diff_guard.zero_diff_detected, true);
            assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
            assert.equal(payload.zero_diff_guard.completion_requires_audited_no_op, true);
        } finally {
            fs.rmSync(commandRepoRoot, { recursive: true, force: true });
        }
    });

    it('accounts for mixed planned modification, rename, delete, recreate, and untracked states', () => {
        writeLines(path.join(repoRoot, 'src', 'unchanged.ts'), 1, 'unchanged');
        writeLines(path.join(repoRoot, 'src', 'modified.ts'), 1, 'modified-before');
        writeLines(path.join(repoRoot, 'src', 'deleted.ts'), 1, 'deleted');
        writeLines(path.join(repoRoot, 'src', 'rename-old.ts'), 1, 'renamed');
        writeLines(path.join(repoRoot, 'src', 'recreated.ts'), 1, 'recreated-before');
        commitAll(repoRoot);

        writeLines(path.join(repoRoot, 'src', 'modified.ts'), 1, 'modified-after');
        fs.rmSync(path.join(repoRoot, 'src', 'deleted.ts'));
        fs.renameSync(
            path.join(repoRoot, 'src', 'rename-old.ts'),
            path.join(repoRoot, 'src', 'rename-new.ts')
        );
        writeLines(path.join(repoRoot, 'src', 'recreated.ts'), 1, 'recreated-after');
        writeLines(path.join(repoRoot, 'src', 'new.ts'), 2, 'new');
        runGit(repoRoot, ['add', '--all', 'src/rename-old.ts', 'src/rename-new.ts']);

        const snapshot = getWorkspaceSnapshot(
            repoRoot,
            'explicit_changed_files',
            true,
            [
                'src/unchanged.ts',
                'src/modified.ts',
                'src/deleted.ts',
                'src/rename-old.ts',
                'src/rename-new.ts',
                'src/recreated.ts',
                'src/new.ts'
            ]
        );

        assert.deepEqual(snapshot.authorized_files, [
            'src/deleted.ts',
            'src/modified.ts',
            'src/new.ts',
            'src/recreated.ts',
            'src/rename-new.ts',
            'src/rename-old.ts',
            'src/unchanged.ts'
        ]);
        assert.deepEqual(snapshot.changed_files, [
            'src/deleted.ts',
            'src/modified.ts',
            'src/new.ts',
            'src/recreated.ts',
            'src/rename-new.ts'
        ]);
        assert.equal(snapshot.changed_lines_total, 7);
        assert.equal(snapshot.additions_total, 4);
        assert.equal(snapshot.deletions_total, 3);
        assert.equal(snapshot.changed_file_stats['src/rename-new.ts'].changed_lines, 0);
        assert.equal('src/unchanged.ts' in snapshot.changed_file_stats, false);
    });
});
