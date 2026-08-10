import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
import {
    evaluatePostReviewSourceMutationGuard,
    hasAuthenticatedFixNowDisposition
} from '../../../../src/gates/next-step/next-step-post-review-source-mutation-guard';
import type { ReviewArtifactState } from '../../../../src/gates/next-step/next-step-review-artifact-readers';

const tempRoots: string[] = [];

afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-post-review-source-guard-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'export const expected = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'config', 'settings.json'), '{"enabled":true}\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'notes.md'), '# Notes\n', 'utf8');
    return repoRoot;
}

function acceptedDeferredState(action: 'create_follow_up' | 'ignore' = 'create_follow_up'): ReviewArtifactState {
    return {
        reviewType: 'performance',
        reviewFindingsValidationAccepted: true,
        failed: false,
        reviewFindingsDisposition: {
            blocking_count: 0,
            counts_by_action: {
                fix_now: 0,
                create_follow_up: action === 'create_follow_up' ? 1 : 0,
                ignore: action === 'ignore' ? 1 : 0
            }
        }
    } as ReviewArtifactState;
}

function acceptedFixNowState(reviewType = 'test'): ReviewArtifactState {
    return {
        reviewType,
        reviewFindingsValidationAccepted: true,
        failed: true,
        reviewFindingsDisposition: {
            blocking_count: 1,
            counts_by_action: {
                fix_now: 1,
                create_follow_up: 0,
                ignore: 0
            }
        }
    } as ReviewArtifactState;
}

function rejectedFailedState(reviewType = 'test'): ReviewArtifactState {
    return {
        reviewType,
        reviewFindingsValidationAccepted: false,
        failed: true,
        reviewFindingsDisposition: null
    } as ReviewArtifactState;
}

function preflightFor(repoRoot: string, changedFiles = ['src/app.ts']): Record<string, unknown> {
    return {
        detection_source: 'explicit_changed_files',
        include_untracked: true,
        metrics: {
            domain_scope_fingerprints: buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles
            })
        }
    };
}

test('allows docs-only post-review delta while source/test/config remain frozen', () => {
    const repoRoot = makeRepo();
    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight: preflightFor(repoRoot),
        workspaceReadiness: {
            ready: false,
            reason: 'docs changed after review',
            currentChangedFiles: ['src/app.ts', 'docs/notes.md']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, false, result.reason);
    assert.match(result.reason, /documentation or closeout domains/);
});

test('blocks Low performance follow-up remediation in the parent while test review is pending', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed while test review remains pending',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, true, result.reason);
    assert.deepEqual(result.accepted_review_types, ['performance']);
    assert.deepEqual(result.mutated_domains, ['implementation']);
    assert.match(result.reason, /performance\(create_follow_up=1, ignore=0\)/);
    assert.match(result.reason, /Do not normalize these changes through classify-change/);
});

test('blocks parent source remediation for an accepted ignored finding', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 3;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed after ignored finding',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState('ignore')],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, true, result.reason);
    assert.match(result.reason, /performance\(create_follow_up=0, ignore=1\)/);
});

test('blocks a direct test-domain mutation after an accepted deferred finding', () => {
    const repoRoot = makeRepo();
    const testPath = path.join(repoRoot, 'tests', 'app.test.ts');
    const preflight = preflightFor(repoRoot, ['tests/app.test.ts']);
    fs.writeFileSync(testPath, 'export const expected = 2;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'test changed after deferred finding',
            currentChangedFiles: ['tests/app.test.ts']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, true, result.reason);
    assert.deepEqual(result.mutated_domains, ['test']);
    assert.deepEqual(result.mutated_files, ['tests/app.test.ts']);
});

test('blocks a direct config-domain mutation after an accepted deferred finding', () => {
    const repoRoot = makeRepo();
    const configPath = path.join(repoRoot, 'config', 'settings.json');
    const preflight = preflightFor(repoRoot, ['config/settings.json']);
    fs.writeFileSync(configPath, '{"enabled":false}\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'config changed after deferred finding',
            currentChangedFiles: ['config/settings.json']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, true, result.reason);
    assert.deepEqual(result.mutated_domains, ['config']);
    assert.deepEqual(result.mutated_files, ['config/settings.json']);
});

test('allows legitimate authenticated fix_now source remediation', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    const fixNowState = acceptedFixNowState();
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 4;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed for fix_now',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [fixNowState],
        authorizedImplementationTransition: hasAuthenticatedFixNowDisposition(fixNowState)
    });

    assert.equal(result.blocked, false, result.reason);
    assert.match(result.reason, /authenticated remediation transition/);
});

test('allows mixed multi-lane dispositions when one current lane requires fix_now', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    const currentFixNowState = acceptedFixNowState('test');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 5;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed for test fix_now after performance follow-up',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState(), currentFixNowState],
        authorizedImplementationTransition: hasAuthenticatedFixNowDisposition(currentFixNowState)
    });

    assert.equal(result.blocked, false, result.reason);
});

test('does not authorize mutation from a stale fix_now receipt outside the current remediation route', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 7;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed while only the deferred lane is current',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState(), acceptedFixNowState('code')],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, true, result.reason);
    assert.deepEqual(result.accepted_review_types, ['performance']);
    assert.match(result.reason, /Post-review source mutation is not authorized/);
});

test('does not authorize remediation from a failed review without accepted fix_now evidence', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    const rejectedState = rejectedFailedState();
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 6;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed after an unauthenticated failed review',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState(), rejectedState],
        authorizedImplementationTransition: hasAuthenticatedFixNowDisposition(rejectedState)
    });

    assert.equal(result.blocked, true, result.reason);
    assert.deepEqual(result.accepted_review_types, ['performance']);
    assert.match(result.reason, /Post-review source mutation is not authorized/);
});

test('continues unchanged-source review navigation without activating the guard', () => {
    const repoRoot = makeRepo();
    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight: preflightFor(repoRoot),
        workspaceReadiness: {
            ready: true,
            reason: 'workspace still matches preflight',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, false, result.reason);
    assert.match(result.reason, /still matches the frozen preflight/);
});

test('preserves normal stale-preflight recovery before any accepted review evidence', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'source changed before review',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [],
        authorizedImplementationTransition: false
    });

    assert.equal(result.blocked, false, result.reason);
    assert.match(result.reason, /No current accepted deferred or ignored/);
});

test('allows an explicitly authorized implementation transition outside deferred-finding recovery', () => {
    const repoRoot = makeRepo();
    const preflight = preflightFor(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 3;\n', 'utf8');

    const result = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: {
            ready: false,
            reason: 'operator-authorized source change',
            currentChangedFiles: ['src/app.ts']
        },
        reviewStates: [acceptedDeferredState()],
        authorizedImplementationTransition: true
    });

    assert.equal(result.blocked, false, result.reason);
    assert.match(result.reason, /authenticated remediation transition/);
});
