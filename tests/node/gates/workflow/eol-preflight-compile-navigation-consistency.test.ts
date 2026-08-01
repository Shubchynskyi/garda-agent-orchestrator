import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runClassifyChangeCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow-classify';
import {
    normalizeGitChangeClassificationEvidence
} from '../../../../src/core/git-change-classification';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { buildShellSmokePreflight } from '../../../../src/gates/diagnostics/shell-smoke-preflight';
import { readCompileReadiness } from '../../../../src/gates/next-step/next-step-compile-readiness';
import {
    readPreflightWorkspaceReadiness
} from '../../../../src/gates/next-step/next-step-preflight-workspace-readiness';
import {
    captureDirtyWorkspaceBaseline
} from '../../../../src/gates/workspace/dirty-worktree-protection';
import { fileSha256 } from '../../../../src/gates/shared/helpers';

function runGit(repoRoot: string, args: string[]): void {
    execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
}

function createFixtureRepo(autocrlf: 'false' | 'input'): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-eol-workflow-consistency-'));
    writeFile(repoRoot, 'package.json', JSON.stringify({ name: 'garda-agent-orchestrator' }));
    writeFile(repoRoot, 'MANIFEST.md', '# Manifest\n');
    writeFile(repoRoot, 'VERSION', '1.0.0\n');
    writeFile(repoRoot, 'bin/garda.js', 'console.log("1.0.0");\n');
    writeFile(repoRoot, '.gitignore', '/runtime/\ngarda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'alpha.txt', 'alpha\nbeta\n');
    writeFile(repoRoot, 'beta.txt', 'one\ntwo\n');
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'tests@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', autocrlf]);
    runGit(repoRoot, ['config', 'core.safecrlf', 'false']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);
    return repoRoot;
}

function classifyPreflight(repoRoot: string): Record<string, unknown> {
    const result = runClassifyChangeCommand({
        repoRoot,
        taskIntent: 'Verify canonical EOL workflow scope',
        emitMetrics: false
    });
    return JSON.parse(result.outputText) as Record<string, unknown>;
}

function assertWorkflowConsumersAgree(repoRoot: string, expectedFiles: string[]): Record<string, unknown> {
    const shellSmoke = buildShellSmokePreflight({
        taskId: 'T-949-3-fixture',
        repoRoot
    });
    const taskModeBaseline = captureDirtyWorkspaceBaseline(repoRoot);
    const compileSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    const preflight = classifyPreflight(repoRoot);
    const shellEvidence = shellSmoke.git_change_classification;
    const taskModeEvidence = taskModeBaseline.git_change_classification;
    const compileEvidence = normalizeGitChangeClassificationEvidence(
        compileSnapshot.git_change_classification
    );
    const preflightEvidence = normalizeGitChangeClassificationEvidence(
        preflight.git_change_classification
    );

    assert.equal(shellSmoke.outcome, 'PASS');
    assert.ok(shellEvidence);
    assert.ok(taskModeEvidence);
    assert.ok(compileEvidence);
    assert.ok(preflightEvidence);
    assert.deepEqual(shellEvidence.effective_changed_files, expectedFiles);
    assert.deepEqual(taskModeBaseline.changed_files, expectedFiles);
    assert.deepEqual(compileSnapshot.changed_files, expectedFiles);
    assert.deepEqual(preflight.changed_files, expectedFiles);
    assert.deepEqual(taskModeEvidence, shellEvidence);
    assert.deepEqual(compileEvidence.effective_changed_files, expectedFiles);
    assert.deepEqual(preflightEvidence.effective_changed_files, expectedFiles);

    const zeroDiffGuard = preflight.zero_diff_guard as Record<string, unknown>;
    assert.equal(zeroDiffGuard.zero_diff_detected, expectedFiles.length === 0);
    const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight);
    assert.equal(readiness.ready, true, readiness.reason);

    return preflight;
}

describe('canonical EOL scope across task entry, preflight, compile, and next-step', () => {
    for (const autocrlf of ['false', 'input'] as const) {
        it(`keeps an unstaged EOL-only change dirty with core.autocrlf=${autocrlf}`, () => {
            const repoRoot = createFixtureRepo(autocrlf);
            try {
                writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
                const preflight = assertWorkflowConsumersAgree(repoRoot, ['alpha.txt']);
                const evidence = normalizeGitChangeClassificationEvidence(
                    preflight.git_change_classification
                );
                assert.deepEqual(evidence?.eol_only_files, ['alpha.txt']);
                assert.deepEqual(evidence?.unstaged_files, ['alpha.txt']);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }

    it('keeps staged EOL-only state in the same effective scope', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
            runGit(repoRoot, ['add', 'alpha.txt']);
            const preflight = assertWorkflowConsumersAgree(repoRoot, ['alpha.txt']);
            const evidence = normalizeGitChangeClassificationEvidence(
                preflight.git_change_classification
            );
            assert.deepEqual(evidence?.eol_only_files, ['alpha.txt']);
            assert.deepEqual(evidence?.staged_files, ['alpha.txt']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps mixed EOL-only and real content changes in one effective scope', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
            writeFile(repoRoot, 'beta.txt', 'one\nchanged\n');
            const preflight = assertWorkflowConsumersAgree(repoRoot, ['alpha.txt', 'beta.txt']);
            const evidence = normalizeGitChangeClassificationEvidence(
                preflight.git_change_classification
            );
            assert.deepEqual(evidence?.eol_only_files, ['alpha.txt']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps a clean workspace baseline-only everywhere', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            assertWorkflowConsumersAgree(repoRoot, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when preflight canonical classification evidence is invalid', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
            const preflight = assertWorkflowConsumersAgree(repoRoot, ['alpha.txt']);
            const classification = preflight.git_change_classification as Record<string, unknown>;
            preflight.git_change_classification = {
                ...classification,
                policy_id: 'forged-policy'
            };

            const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight);

            assert.equal(readiness.ready, false);
            assert.match(readiness.reason, /canonical Git\/EOL classification evidence is invalid/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('validates canonical Git/EOL evidence before accepting compile readiness', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
            const preflight = assertWorkflowConsumersAgree(repoRoot, ['alpha.txt']);
            const taskId = 'T-949-3-compile-fixture';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
            const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
            const classification = snapshot.git_change_classification;

            assert.ok(classification);
            const compileEvidence: Record<string, unknown> = {
                task_id: taskId,
                event_source: 'compile-gate',
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: '',
                scope_detection_source: snapshot.detection_source,
                scope_include_untracked: snapshot.include_untracked,
                scope_authorized_files: snapshot.authorized_files,
                scope_authorized_files_count: snapshot.authorized_files_count,
                scope_authorized_files_sha256: snapshot.authorized_files_sha256,
                scope_changed_files: snapshot.changed_files,
                scope_changed_lines_total: snapshot.changed_lines_total,
                scope_changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256,
                scope_git_change_classification: classification
            };

            writeFile(repoRoot, path.relative(repoRoot, preflightPath), `${JSON.stringify(preflight)}\n`);
            compileEvidence.preflight_hash_sha256 = fileSha256(preflightPath);
            writeFile(repoRoot, path.relative(repoRoot, compilePath), `${JSON.stringify(compileEvidence)}\n`);

            const validReadiness = readCompileReadiness(
                repoRoot,
                reviewsRoot,
                eventsRoot,
                taskId,
                preflightPath
            );
            assert.equal(validReadiness.ready, true, validReadiness.reason);

            compileEvidence.scope_git_change_classification = {
                ...classification,
                policy_id: 'forged-policy'
            };
            writeFile(repoRoot, path.relative(repoRoot, compilePath), `${JSON.stringify(compileEvidence)}\n`);

            const invalidReadiness = readCompileReadiness(
                repoRoot,
                reviewsRoot,
                eventsRoot,
                taskId,
                preflightPath
            );
            assert.equal(invalidReadiness.ready, false);
            assert.match(invalidReadiness.reason, /canonical Git\/EOL classification evidence is invalid/);

            compileEvidence.scope_git_change_classification = classification;
            compileEvidence.scope_changed_files = [];
            writeFile(repoRoot, path.relative(repoRoot, compilePath), `${JSON.stringify(compileEvidence)}\n`);

            const inconsistentReadiness = readCompileReadiness(
                repoRoot,
                reviewsRoot,
                eventsRoot,
                taskId,
                preflightPath
            );
            assert.equal(inconsistentReadiness.ready, false);
            assert.match(inconsistentReadiness.reason, /does not match its scope snapshot/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps real content drift blocking after preflight', () => {
        const repoRoot = createFixtureRepo('false');
        try {
            writeFile(repoRoot, 'beta.txt', 'one\nchanged\n');
            const preflight = assertWorkflowConsumersAgree(repoRoot, ['beta.txt']);
            writeFile(repoRoot, 'beta.txt', 'one\nchanged-again\n');

            const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight);

            assert.equal(readiness.ready, false);
            assert.match(readiness.reason, /scope_content_sha256|changed_lines_total/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
