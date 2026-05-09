import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateStrictDeferredReviewFollowups } from '../../../src/gates/completion-deferred-followups';

// Tests for TASK.md formatting variants outside the canonical Active Queue contract.
// These tests document current parser behavior (fail-closed for malformed inputs,
// pass for accepted case-insensitive variants). No new formatting support is added;
// no src/** files are modified. If a test exposes a desired behavior change, a
// separate implementation task should be created.

const FINDING_TEXT = 'Resolve the deferred formatting variant follow-up.';
const ARTIFACT_REL = 'garda-agent-orchestrator/runtime/reviews/T-501-code.md';

function makeFindings(artifactAbsPath: string) {
    return [{
        reviewType: 'code',
        artifactPath: artifactAbsPath,
        findings: [FINDING_TEXT]
    }];
}

function canonicalTaskMdRows(artifactRelPath: string): string[] {
    return [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. |',
        `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced | Deferred from T-501 code review artifact ${artifactRelPath}. Original finding: ${FINDING_TEXT} |`
    ];
}

describe('validateStrictDeferredReviewFollowups — TASK.md formatting variants', () => {
    it('baseline: canonical Active Queue format is accepted', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                ...canonicalTaskMdRows(ARTIFACT_REL)
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('accepts case-insensitive Active Queue heading (## active queue)', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## active queue',
                ...canonicalTaskMdRows(ARTIFACT_REL)
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // The regex /^##\s+Active Queue\s*$/i is case-insensitive: lowercase heading is treated
            // as the Active Queue section and the follow-up row is found.
            assert.equal(result.status, 'PASS');
            assert.equal(result.matched_count, 1);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue heading uses h3 (### Active Queue)', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '### Active Queue',
                ...canonicalTaskMdRows(ARTIFACT_REL)
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // ### is not matched by /^##\s+Active Queue\s*$/i; the section is never activated.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue heading has trailing extra text', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue (deprecated)',
                ...canonicalTaskMdRows(ARTIFACT_REL)
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // The $ anchor in /^##\s+Active Queue\s*$/i rejects any non-whitespace suffix.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when TASK.md is empty', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), '', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue section exists but contains no table', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '',
                'No table here, just prose.',
                ''
            ].join('\n'), 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue table header has an extra (10th) column', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                // Header has 10 columns — isTaskQueueHeader requires exactly 9.
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes | Extra |',
                '|---|---|---|---|---|---|---|---|---|---|',
                '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. | x |',
                `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced | Deferred from T-501 code review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} | x |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // isTaskQueueHeader rejects headers that don't have exactly 9 canonical cells.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue table separator has wrong cell count', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                // Separator has only 8 dashes — isTaskQueueSeparator requires exactly 9.
                '|---|---|---|---|---|---|---|---|',
                '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. |',
                `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced | Deferred from T-501 code review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // Without a valid separator, the parser never advances past the header state
            // and collects zero rows.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when a data row has fewer than 9 columns', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            // Row for T-502 has only 8 cells; the notes cell is absent.
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. |',
                `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // Rows with cell count != 9 are skipped; no valid follow-up is found.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue table header column names are wrong', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                // "Description" replaces canonical "Notes" — isTaskQueueHeader rejects this.
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Description |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. |',
                `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced | Deferred from T-501 code review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // isTaskQueueHeader requires all 9 canonical cell names; a non-matching header is skipped.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when Active Queue heading is a level-1 heading (# Active Queue)', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# Active Queue',
                ...canonicalTaskMdRows(ARTIFACT_REL)
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // /^##\s+/ requires exactly two hashes; # Active Queue is not matched.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('stops scanning rows when a new ## section starts inside Active Queue', () => {
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-taskmd-fmt-'));
        try {
            const artifactAbs = path.join(tempDir, ARTIFACT_REL);
            // The follow-up row T-502 appears AFTER the ## Backlog section header,
            // so it should not be found.
            fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-501 | 🟨 IN_PROGRESS | P1 | tests | Parent task | gpt-5.4 | 2026-05-09 | strict | Active. |',
                '',
                '## Backlog',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| T-502 | 🟦 TODO | P2 | tests | Deferred follow-up | gpt-5.4 | 2026-05-09 | balanced | Deferred from T-501 code review artifact ${ARTIFACT_REL}. Original finding: ${FINDING_TEXT} |`
            ].join('\n') + '\n', 'utf8');

            const result = validateStrictDeferredReviewFollowups({
                repoRoot: tempDir,
                taskId: 'T-501',
                activeProfile: 'strict',
                reviewFindings: makeFindings(artifactAbs)
            });

            // A new ## heading exits the Active Queue; rows after it are not scanned.
            assert.equal(result.status, 'FAILED');
            assert.equal(result.matched_count, 0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
