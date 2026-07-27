import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    testReviewArtifacts
} from '../../../src/cli/commands/gate-flows/review/review-flow-support';
import {
    resolveRecoveryPreflightPath
} from '../../../src/cli/commands/gate-flows/recovery/recovery-flow-restart-evidence';
import {
    resolveNextStepFromCliOptions
} from '../../../src/gates/next-step/next-step';
import {
    resolveReviewsRoot
} from '../../../src/gates/task-audit/task-audit-summary-collectors';
import {
    isPathRealpathInsideRoot
} from '../../../src/gates/shared/helpers';

function normalizePath(pathValue: string): string {
    return pathValue.replace(/\\/gu, '/');
}

test('reports repository-resolved candidates for relative containment escapes', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-containment-diagnostics-'));
    const repoRoot = path.join(fixtureRoot, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

    const relativeEscape = path.join('..', 'outside', 'reviews');
    const expectedCandidate = normalizePath(path.resolve(repoRoot, relativeEscape));
    const expectedDiagnostic = `ReviewsRoot must resolve inside repo root without symlink or junction escape: ${expectedCandidate}`;

    assert.equal(isPathRealpathInsideRoot(path.join(repoRoot, 'missing.json'), repoRoot, { allowMissing: true }), true);

    const reviewResult = testReviewArtifacts(
        repoRoot,
        'T-relative-containment',
        {},
        {},
        [],
        relativeEscape
    );
    assert.equal(reviewResult.reviews_root, expectedCandidate);
    assert.deepEqual(reviewResult.violations, [expectedDiagnostic]);

    assert.throws(
        () => resolveNextStepFromCliOptions({
            taskId: 'T-relative-containment',
            repoRoot,
            reviewsRoot: relativeEscape
        }),
        (error: unknown) => error instanceof Error && error.message === expectedDiagnostic
    );

    assert.throws(
        () => resolveReviewsRoot(repoRoot, relativeEscape),
        (error: unknown) => error instanceof Error && error.message === expectedDiagnostic
    );

    const relativePreflightEscape = path.join('..', 'outside', 'T-relative-containment-preflight.json');
    const expectedPreflightCandidate = normalizePath(path.resolve(repoRoot, relativePreflightEscape));
    assert.throws(
        () => resolveRecoveryPreflightPath(
            repoRoot,
            'T-relative-containment',
            relativePreflightEscape,
            'PreflightPath'
        ),
        (error: unknown) => (
            error instanceof Error
            && error.message === (
                `PreflightPath must resolve inside repo root without symlink or junction escape: ${expectedPreflightCandidate}`
            )
        )
    );
    assert.throws(
        () => resolveNextStepFromCliOptions({
            repoRoot,
            preflightPath: relativePreflightEscape
        }),
        (error: unknown) => (
            error instanceof Error
            && error.message.startsWith(
                `PreflightPath must resolve inside repo root without symlink or junction escape: ${expectedPreflightCandidate}.`
            )
        )
    );
});
