import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildFullSuiteTimeoutBlockerIdentity,
    resolveFullSuiteTimeoutBlockerEvidence
} from '../../../../src/gates/full-suite/full-suite-repeated-blocker';

const PARENT_TASK_ID = 'T-REPEATED-BLOCKER';
const CHILD_TASK_ID = `${PARENT_TASK_ID}-F1`;
const SIBLING_TASK_ID = `${PARENT_TASK_ID}-F2`;
const SCOPE_SHA256 = 'a'.repeat(64);
const OTHER_SCOPE_SHA256 = 'b'.repeat(64);
const tempRoots: string[] = [];

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeRepo(): { repoRoot: string; baseCommit: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repeated-blocker-'));
    tempRoots.push(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${PARENT_TASK_ID} | IN_PROGRESS | P0 | workflow/full-suite | Parent | gpt-5.6 | 2026-07-31 | balanced | Decomposition source: orchestrator (2026-07-31); child tasks: \`${CHILD_TASK_ID}\`, \`${SIBLING_TASK_ID}\`. |`,
        `| ${CHILD_TASK_ID} | TODO | P0 | workflow/diagnostics | Diagnose blocker | gpt-5.6 | 2026-07-31 | balanced | Child of \`${PARENT_TASK_ID}\`. |`,
        `| ${SIBLING_TASK_ID} | TODO | P0 | workflow/repair | Repair blocker | gpt-5.6 | 2026-07-31 | balanced | Child of \`${PARENT_TASK_ID}\`. |`,
        ''
    ].join('\n'), 'utf8');
    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['add', 'README.md', 'TASK.md']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return {
        repoRoot,
        baseCommit: runGit(repoRoot, ['rev-parse', 'HEAD'])
    };
}

function seedParentTimeoutArtifact(repoRoot: string, baseCommit: string): void {
    const identity = buildFullSuiteTimeoutBlockerIdentity({
        sourceTaskId: PARENT_TASK_ID,
        observedTaskId: PARENT_TASK_ID,
        baseCommit,
        scopeSha256: SCOPE_SHA256
    });
    writeJson(
        path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${PARENT_TASK_ID}-full-suite-validation.json`
        ),
        {
            task_id: PARENT_TASK_ID,
            status: 'FAILED',
            timed_out: true,
            timeout_policy: {
                timeout_blocker: true,
                attempts_exhausted: true,
                blocker_identity: identity,
                repair_task_proposal: {
                    suggested_task_id: CHILD_TASK_ID,
                    title: 'Fix full-suite timeout blocker',
                    area: 'workflow/full-suite-timeout',
                    rationale: 'The configured timeout retry policy was exhausted.'
                }
            }
        }
    );
}

function cycleBinding(scopeSha256: string) {
    return {
        task_id: CHILD_TASK_ID,
        preflight_path: `runtime/reviews/${CHILD_TASK_ID}-preflight.json`,
        preflight_sha256: 'c'.repeat(64),
        compile_gate_timestamp: '2026-07-31T00:00:00.000Z',
        scope_binding: {
            changed_files_sha256: 'd'.repeat(64),
            scope_sha256: scopeSha256,
            scope_content_sha256: 'e'.repeat(64)
        }
    };
}

afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

describe('full-suite repeated blocker guard', () => {
    it('fingerprints source task, base, scope, gate, and failure class without the observed child id', () => {
        const baseCommit = '1'.repeat(40);
        const parent = buildFullSuiteTimeoutBlockerIdentity({
            sourceTaskId: PARENT_TASK_ID,
            observedTaskId: PARENT_TASK_ID,
            baseCommit,
            scopeSha256: SCOPE_SHA256
        });
        const child = buildFullSuiteTimeoutBlockerIdentity({
            sourceTaskId: PARENT_TASK_ID,
            observedTaskId: CHILD_TASK_ID,
            baseCommit,
            scopeSha256: SCOPE_SHA256
        });

        assert.equal(parent.fingerprint_sha256, child.fingerprint_sha256);
        assert.equal(child.gate, 'full-suite-validation');
        assert.equal(child.failure_class, 'timeout_retry_exhausted');
        assert.notEqual(
            child.fingerprint_sha256,
            buildFullSuiteTimeoutBlockerIdentity({
                sourceTaskId: PARENT_TASK_ID,
                observedTaskId: CHILD_TASK_ID,
                baseCommit: '2'.repeat(40),
                scopeSha256: SCOPE_SHA256
            }).fingerprint_sha256
        );
        assert.notEqual(
            child.fingerprint_sha256,
            buildFullSuiteTimeoutBlockerIdentity({
                sourceTaskId: PARENT_TASK_ID,
                observedTaskId: CHILD_TASK_ID,
                baseCommit,
                scopeSha256: OTHER_SCOPE_SHA256
            }).fingerprint_sha256
        );
    });

    it('blocks a stale repeated blocker on a repair child and preserves operator-visible provenance', () => {
        const { repoRoot, baseCommit } = makeRepo();
        seedParentTimeoutArtifact(repoRoot, baseCommit);

        const evidence = resolveFullSuiteTimeoutBlockerEvidence({
            repoRoot,
            taskId: CHILD_TASK_ID,
            cycleBinding: cycleBinding(SCOPE_SHA256)
        });

        assert.equal(evidence.blocker_identity.source_task_id, PARENT_TASK_ID);
        assert.equal(evidence.blocker_identity.observed_task_id, CHILD_TASK_ID);
        assert.equal(evidence.repeated_blocker_analysis?.matched_ancestor_task_id, PARENT_TASK_ID);
        assert.equal(
            evidence.repeated_blocker_analysis?.required_resolution,
            'TRUE_DECOMPOSITION_OR_EXPLICIT_RECOVERY_DECISION'
        );
    });

    it('prevents a changed child scope from matching a stale blocker fingerprint', () => {
        const { repoRoot, baseCommit } = makeRepo();
        seedParentTimeoutArtifact(repoRoot, baseCommit);

        const evidence = resolveFullSuiteTimeoutBlockerEvidence({
            repoRoot,
            taskId: CHILD_TASK_ID,
            cycleBinding: cycleBinding(OTHER_SCOPE_SHA256)
        });

        assert.equal(evidence.blocker_identity.source_task_id, PARENT_TASK_ID);
        assert.equal(evidence.repeated_blocker_analysis, null);
    });

    it('fails closed when repair ancestor blocker evidence is malformed', () => {
        const { repoRoot } = makeRepo();
        const ancestorArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${PARENT_TASK_ID}-full-suite-validation.json`
        );
        fs.mkdirSync(path.dirname(ancestorArtifactPath), { recursive: true });
        fs.writeFileSync(ancestorArtifactPath, '{not-json', 'utf8');

        assert.throws(
            () => resolveFullSuiteTimeoutBlockerEvidence({
                repoRoot,
                taskId: CHILD_TASK_ID,
                cycleBinding: cycleBinding(SCOPE_SHA256)
            }),
            /Cannot safely evaluate repeated blocker ancestry/u
        );
    });

    it('rejects blocker evidence when only a task-specific preflight hash is available', () => {
        const { repoRoot } = makeRepo();

        assert.throws(
            () => resolveFullSuiteTimeoutBlockerEvidence({
                repoRoot,
                taskId: PARENT_TASK_ID,
                cycleBinding: {
                    task_id: PARENT_TASK_ID,
                    preflight_path: `runtime/reviews/${PARENT_TASK_ID}-preflight.json`,
                    preflight_sha256: 'c'.repeat(64),
                    compile_gate_timestamp: '2026-07-31T00:00:00.000Z',
                    scope_binding: {
                        changed_files_sha256: 'd'.repeat(64),
                        scope_sha256: null,
                        scope_content_sha256: null
                    }
                }
            }),
            /requires a current scope sha256/u
        );
    });
});
