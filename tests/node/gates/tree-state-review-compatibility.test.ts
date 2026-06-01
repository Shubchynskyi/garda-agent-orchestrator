import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();

function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertSourceContains(relativePath: string, expected: string): void {
    const source = readRepoFile(relativePath);
    assert.ok(
        source.includes(expected),
        `Expected ${relativePath} to keep compatibility coverage: ${expected}`
    );
}

test('tree-state review compatibility suite keeps the focused regression shards wired together', () => {
    for (const [relativePath, expected] of [
        [
            'tests/node/gates/review-tree-state.test.ts',
            "captures staged-only, unstaged-only, mixed MM, and untracked path states"
        ],
        [
            'tests/node/gates/review-tree-state.test.ts',
            "shares current freshness snapshots across repeated review artifact checks"
        ],
        [
            'tests/node/gates/review-tree-state.test.ts',
            "binds in-repo symlink targets into review and reuse fingerprints"
        ],
        [
            'tests/node/gates/review-tree-state.test.ts',
            "captures broken symlinks as link-text-only reviewable entries"
        ],
        [
            'tests/node/gates/review-tree-state.test.ts',
            "fails closed for symlinks to directories because reviewer-visible file content is unreviewable"
        ],
        [
            'tests/node/gates/reviewer-launch-tree-state.test.ts',
            "blocks record-review-routing when a staged review context becomes MM before routing"
        ],
        [
            'tests/node/gates/reviewer-launch-tree-state.test.ts',
            "blocks complete-reviewer-launch when a prepared staged launch becomes MM before completion"
        ],
        [
            'tests/node/gates/reviewer-launch-tree-state.test.ts',
            "blocks record-review-invocation when a completed staged launch becomes MM before attestation"
        ],
        [
            'tests/node/gates/reviewer-launch-tree-state.test.ts',
            "blocks record-review-result when an attested staged review becomes MM before receipt materialization"
        ],
        [
            'tests/node/gates/review-context-contract.test.ts',
            "review-context contract rejects scoped diff metadata from an older preflight with the same files"
        ],
        [
            'tests/node/gates/review-context-contract.test.ts',
            "review-context contract rejects scoped diff metadata with stale staged mode"
        ],
        [
            'tests/node/gates/review-reuse.test.ts',
            "fingerprints staged scope from the index instead of the dirty working tree"
        ],
        [
            'tests/node/gates/review-reuse.test.ts',
            "does not fingerprint review reuse scope from files reached through symlinked directories outside repo"
        ],
        [
            'tests/node/cli/commands/gates-command-required-reviews.test.ts',
            "fails required reviews gate when receipt tree-state binding is missing or tampered"
        ],
        [
            'tests/node/cli/commands/gates-command-review-launch-routing.test.ts',
            "record-review-routing rejects schema-less review contexts without tree_state binding"
        ],
        [
            'tests/node/cli/commands/gates-command-review-launch-prepared.test.ts',
            "prepare-reviewer-launch rejects stale staged review contexts after MM drift"
        ],
        [
            'tests/node/cli/commands/gates-command-required-reviews.test.ts',
            "required-reviews-check rejects passed staged receipts after same-path MM drift"
        ],
        [
            'tests/node/cli/commands/gates-command-review-result-receipt.test.ts',
            "record-review-result accepts legacy review-context identity when task-mode runtime identity is backfilled safely"
        ],
        [
            'tests/node/cli/commands/gates-command-required-reviews.test.ts',
            "required-reviews-check and completion prefer canonical review-context artifacts over stale legacy default files"
        ],
        [
            'tests/node/cli/commands/gates-review-reuse-stale-evidence.test.ts',
            "does not reuse historical review-recorded evidence when the review artifact path uses parent traversal"
        ],
        [
            'tests/node/cli/commands/gates-review-reuse-stale-evidence.test.ts',
            "does not reuse prior code-review evidence without historical reviewer tree-state binding"
        ],
        [
            'tests/node/cli/commands/gates-review-reuse-remediation.test.ts',
            "completion review-skill evidence rejects reused receipts when the current review context file drifts"
        ],
        [
            'tests/node/cli/commands/gates-completion-fixtures.ts',
            'receipt_snapshot_path: path.normalize(receiptSnapshotPath)'
        ],
        [
            'tests/node/cli/commands/gates-completion-fixtures.ts',
            'review_artifact_snapshot_path: path.normalize(artifactSnapshotPath)'
        ],
        [
            'tests/node/cli/commands/gates-completion-fixtures.ts',
            'reviewScopeSha256: computeReviewRelevantScopeFingerprint'
        ],
        [
            'tests/node/cli/commands/gate-test-seed-helpers.ts',
            'DECOMPOSED'
        ]
    ] as const) {
        assertSourceContains(relativePath, expected);
    }
});

test('tree-state review compatibility suite documents Windows symlink privilege skips', () => {
    const reviewTreeStateSource = readRepoFile('tests/node/gates/review-tree-state.test.ts');

    assert.match(
        reviewTreeStateSource,
        /t\.skip\(`file symlink creation unavailable in this environment:/,
        'file symlink privilege failures should be explicit skips, not silent coverage loss'
    );
    assert.match(
        reviewTreeStateSource,
        /t\.skip\(`directory symlink creation unavailable in this environment:/,
        'directory symlink privilege failures should be explicit skips, not silent coverage loss'
    );
});
