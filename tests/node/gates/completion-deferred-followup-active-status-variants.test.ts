import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateStrictDeferredReviewFollowups } from '../../../src/gates/completion-deferred-followups';

// Positive coverage for every canonical active deferred follow-up status variant.
// The active-status allow-list is intentionally limited to: TODO, IN_PROGRESS,
// IN_REVIEW (both space and underscore normalised variants).
// No src/** files are modified; only tests/fixtures/assertions.

const FINDING_TEXT = 'Verify active status variant handling.';
const ARTIFACT_REL = 'garda-agent-orchestrator/runtime/reviews/T-466-test.md';

function makeFindings(artifactAbsPath: string) {
    return [{
        reviewType: 'test',
        artifactPath: artifactAbsPath,
        findings: [FINDING_TEXT]
    }];
}

function taskMdWithStatus(statusCol: string): string[] {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-466 | 🟦 TODO | P5 | tests | Active task | gpt-5.4 | 2026-05-08 | fast | Active. |',
        `| T-467 | ${statusCol} | P5 | tests | Deferred follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-466 test review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
    ];
}

describe('validateStrictDeferredReviewFollowups — active status variants (positive)', () => {
    it('accepts TODO as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟦 TODO').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('accepts IN_PROGRESS as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟨 IN_PROGRESS').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('accepts IN_REVIEW (underscore) as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟧 IN_REVIEW').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('accepts in_review (lowercase without emoji) as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-466 | TODO | P5 | tests | Active task | gpt-5.4 | 2026-05-08 | fast | Active. |',
                `| T-467 | in_review | P5 | tests | Deferred follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-466 test review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects in progress (space variant) because it is not in the canonical active-status allow-list', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-466 | TODO | P5 | tests | Active task | gpt-5.4 | 2026-05-08 | fast | Active. |',
                `| T-467 | in progress | P5 | tests | Deferred follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-466 test review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // 'in progress' (space) is not in ACTIVE_FOLLOWUP_STATUSES; only 'in_review' and 'in review' are.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
            assert.ok(result.violations.length > 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects DONE as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟩 DONE').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
            assert.ok(result.violations.length > 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects BLOCKED as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟥 BLOCKED').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
            assert.ok(result.violations.length > 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects SPLIT_REQUIRED as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟫 SPLIT_REQUIRED').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
            assert.ok(result.violations.length > 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects DECOMPOSED as an active follow-up status', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-active-status-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), taskMdWithStatus('🟪 DECOMPOSED').join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-466',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
            assert.ok(result.violations.length > 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
