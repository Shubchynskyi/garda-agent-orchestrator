import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    testReviewArtifacts
} from '../../../../src/cli/commands/gate-flows/review/review-flow-support';

describe('cli/commands/gate-flows/review-flow-support', () => {
    it('rejects required-review artifacts from reviews roots that escape through symlinked directories', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-flow-support-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-flow-support-outside-'));
        const taskId = 'T-265-required-review-link';
        try {
            const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
            const reviewsRoot = path.join(runtimeRoot, 'reviews');
            fs.mkdirSync(runtimeRoot, { recursive: true });
            fs.writeFileSync(path.join(outsideRoot, `${taskId}-code.md`), [
                '# Review',
                '',
                'This outside artifact must not be accepted through a repo-local reviews root alias.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(outsideRoot, `${taskId}-code-review-context.json`), '{}\n', 'utf8');
            try {
                fs.symlinkSync(outsideRoot, reviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const result = testReviewArtifacts(
                repoRoot,
                taskId,
                { code: true },
                { code: 'REVIEW PASSED' },
                [],
                reviewsRoot
            );

            assert.equal(result.checked.length, 0);
            assert.ok(
                result.violations.some((line) => line.includes('ReviewsRoot must resolve inside repo root without symlink or junction escape')),
                result.violations.join('\n')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('keeps missing safe review artifacts as missing-artifact violations', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-flow-support-missing-'));
        const taskId = 'T-265-missing-review';
        try {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });

            const result = testReviewArtifacts(
                repoRoot,
                taskId,
                { code: true },
                { code: 'REVIEW PASSED' },
                [],
                reviewsRoot
            );

            assert.ok(
                result.violations.some((line) => line.includes("Review artifact not found for claimed 'REVIEW PASSED'")),
                result.violations.join('\n')
            );
            assert.equal(
                result.violations.some((line) => line.includes('Review artifact path must resolve inside repo root')),
                false
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
