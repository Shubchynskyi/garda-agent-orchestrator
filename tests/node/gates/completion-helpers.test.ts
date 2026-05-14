import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    collectOrderedTimelineEvents,
    extractMarkdownSectionLines,
    getCanonicalReviewSectionHeading,
    isMeaningfulReviewEntry,
    formatCompletionGateResult,
    getFindingsBySeverity,
    isTrivialReview
} from '../../../src/gates/completion';
import { validateStrictDeferredReviewFollowups } from '../../../src/gates/completion-deferred-followups';
import { buildReviewTrustSummary } from '../../../src/gates/review-trust-summary';
describe('gates/completion — helpers and formatters', () => {
    describe('validateStrictDeferredReviewFollowups', () => {
        it('blocks strict deferred findings until a TASK.md follow-up preserves source review details', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    '| T-999 | 🟦 TODO | P2 | workflow | Existing unrelated follow-up | gpt-5.4 | 2026-05-08 | balanced | Mentions T-371 and code but not the source artifact or original finding. |'
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: ['Add a regression for deferred finding follow-up dedupe.']
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.checked_count, 1);
                assert.match(result.violations[0], /must be materialized as a separate TASK\.md follow-up/);
                assert.match(result.violations[0], /Suggested follow-up task id: T-371-F1/);
                assert.match(result.violations[0], /T-371-code\.md/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('suggests the next parent-derived follow-up id when earlier F suffixes exist', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    '| T-371-F1 | 🟦 TODO | P2 | workflow | Existing follow-up | gpt-5.4 | 2026-05-08 | balanced | Existing parent-derived follow-up. |',
                    '| t-371-f2 | 🟦 TODO | P2 | workflow | Existing lower-case follow-up | gpt-5.4 | 2026-05-08 | balanced | Existing parent-derived follow-up. |'
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: ['Add another deferred follow-up regression.']
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.match(result.violations[0], /Suggested follow-up task id: T-371-F3/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('accepts strict deferred findings when a separate TASK.md row preserves parent, review type, artifact, and original finding text', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    '| T-371-F1 | 🟦 TODO | P2 | workflow | Materialized deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact garda-agent-orchestrator/runtime/reviews/T-371-code.md. Original finding: Add a regression for deferred finding follow-up dedupe. |'
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: ['Add a regression for deferred finding follow-up dedupe.']
                    }]
                });

                assert.equal(result.status, 'PASS');
                assert.equal(result.checked_count, 1);
                assert.equal(result.matched_count, 1);
                assert.deepEqual(result.violations, []);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects exact deferred finding matches outside the active queue', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    '',
                    '## Historical Notes',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    `| T-999 | 🟦 TODO | P2 | workflow | Archived deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects parent task rows even when notes preserve deferred finding details', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    `| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('fails closed when TASK.md has no active queue heading', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    `| T-999 | 🟦 TODO | P2 | workflow | Deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('fails closed when the active queue table is malformed', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    `| T-999 | 🟦 TODO | P2 | workflow | Deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects deferred finding matches hidden in noncanonical extra columns', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    `| T-999 | 🟦 TODO | P2 | workflow | Deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects deferred finding matches outside the canonical notes column', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    `| T-999 | 🟦 TODO | P2 | workflow | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} | gpt-5.4 | 2026-05-08 | balanced | Notes intentionally omit deferred review evidence. |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects terminal task rows as strict deferred finding follow-ups', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            const findingText = 'Add a regression for deferred finding follow-up dedupe.';
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    `| T-999 | 🟩 DONE | P2 | workflow | Completed deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'code',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                        findings: [findingText]
                    }]
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(result.matched_count, 0);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('rejects blocked, split-required, and decomposed task rows as strict deferred finding follow-ups', () => {
            for (const status of ['🟥 BLOCKED', '🟫 SPLIT_REQUIRED', '⬜ DECOMPOSED']) {
                const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
                const findingText = 'Add a regression for deferred finding follow-up dedupe.';
                try {
                    fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                        '# TASK.md',
                        '',
                        '## Active Queue',
                        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                        '|---|---|---|---|---|---|---|---|---|',
                        '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                        `| T-999 | ${status} | P2 | workflow | Stopped deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                    ].join('\n') + '\n', 'utf8');

                    const result = validateStrictDeferredReviewFollowups({
                        repoRoot: tempDir,
                        taskId: 'T-371',
                        activeProfile: 'strict',
                        reviewFindings: [{
                            reviewType: 'code',
                            artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                            findings: [findingText]
                        }]
                    });

                    assert.equal(result.status, 'FAILED', status);
                    assert.equal(result.matched_count, 0, status);
                } finally {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            }
        });

        it('rejects non-canonical active-looking task statuses', () => {
            for (const status of ['NOT TODO', 'TODO_ARCHIVED']) {
                const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
                const findingText = 'Add a regression for deferred finding follow-up dedupe.';
                try {
                    fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                        '# TASK.md',
                        '',
                        '## Active Queue',
                        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                        '|---|---|---|---|---|---|---|---|---|',
                        '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                        `| T-999 | ${status} | P2 | workflow | Noncanonical deferred review follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 code review artifact T-371-code.md. Original finding: ${findingText} |`
                    ].join('\n') + '\n', 'utf8');

                    const result = validateStrictDeferredReviewFollowups({
                        repoRoot: tempDir,
                        taskId: 'T-371',
                        activeProfile: 'strict',
                        reviewFindings: [{
                            reviewType: 'code',
                            artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-code.md'),
                            findings: [findingText]
                        }]
                    });

                    assert.equal(result.status, 'FAILED', status);
                    assert.equal(result.matched_count, 0, status);
                } finally {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            }
        });

        it('matches deferred finding text containing escaped markdown table pipes', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-deferred-followups-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'TASK.md'), [
                    '# TASK.md',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-371 | 🟨 IN_PROGRESS | P1 | workflow | Parent | gpt-5.4 | 2026-05-08 | strict | Active task. |',
                    '| T-999 | 🟦 TODO | P2 | workflow | Pipe-safe follow-up | gpt-5.4 | 2026-05-08 | balanced | Deferred from T-371 refactor review artifact T-371-refactor.md. Original finding: Preserve union text A \\| B in follow-up matching. |'
                ].join('\n') + '\n', 'utf8');

                const result = validateStrictDeferredReviewFollowups({
                    repoRoot: tempDir,
                    taskId: 'T-371',
                    activeProfile: 'strict',
                    reviewFindings: [{
                        reviewType: 'refactor',
                        artifactPath: path.join(tempDir, 'garda-agent-orchestrator/runtime/reviews/T-371-refactor.md'),
                        findings: ['Preserve union text A | B in follow-up matching.']
                    }]
                });

                assert.equal(result.status, 'PASS');
                assert.equal(result.matched_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('does not require follow-up materialization outside strict profile', () => {
            const result = validateStrictDeferredReviewFollowups({
                repoRoot: process.cwd(),
                taskId: 'T-450',
                activeProfile: 'balanced',
                reviewFindings: [{
                    reviewType: 'code',
                    artifactPath: 'runtime/reviews/T-450-code.md',
                    findings: ['Document a non-blocking balanced follow-up.']
                }]
            });

            assert.equal(result.status, 'NOT_REQUIRED');
            assert.equal(result.required, false);
        });
    });

    describe('collectOrderedTimelineEvents', () => {
        it('continues scanning valid events after an invalid JSON line', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-timeline-'));
            const timelinePath = path.join(tempDir, 'timeline.jsonl');

            try {
                fs.writeFileSync(
                    timelinePath,
                    [
                        JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00.000Z' }),
                        '{"event_type":',
                        JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:02:00.000Z' }),
                        JSON.stringify({ event_type: 'REVIEW_GATE_PASSED', timestamp_utc: '2026-01-01T00:03:00.000Z' })
                    ].join('\n') + '\n',
                    'utf8'
                );

                const errors: string[] = [];
                const events = collectOrderedTimelineEvents(timelinePath, errors);

                assert.equal(errors.length, 1);
                assert.deepEqual(
                    events.map((entry) => entry.event_type),
                    ['TASK_MODE_ENTERED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED']
                );
                assert.deepEqual(
                    events.map((entry) => entry.sequence),
                    [0, 2, 3]
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('extractMarkdownSectionLines', () => {
        it('extracts lines under matching heading', () => {
            const lines = [
                '## Introduction',
                'Some intro text.',
                '',
                '## Findings by Severity',
                '- Critical: SQL injection',
                '- High: XSS vulnerability',
                '',
                '## Residual Risks',
                '- None'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.ok(result.length >= 2);
            assert.ok(result.some(l => l.includes('Critical')));
        });

        it('stops at next heading', () => {
            const lines = [
                '## Findings by Severity',
                '- Low: minor issue',
                '## Next Section',
                '- irrelevant'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.equal(result.length, 1);
        });

        it('normalizes obvious reviewer section heading variants', () => {
            assert.equal(getCanonicalReviewSectionHeading('**Findings by Severity**'), 'Findings by Severity');
            assert.equal(getCanonicalReviewSectionHeading('### Residual Risks'), 'Residual Risks');
            assert.equal(getCanonicalReviewSectionHeading('## **Verdict**'), 'Verdict');
            assert.equal(getCanonicalReviewSectionHeading('**## Deferred Findings**'), 'Deferred Findings');

            const result = extractMarkdownSectionLines([
                '**Findings by Severity**',
                'none',
                '## **Residual Risks**',
                'none'
            ], 'Findings by Severity');
            assert.deepEqual(result, ['none']);
        });
    });

    describe('isMeaningfulReviewEntry', () => {
        it('returns false for "none" variations', () => {
            assert.equal(isMeaningfulReviewEntry('none'), false);
            assert.equal(isMeaningfulReviewEntry('N/A'), false);
        });
        it('returns true for real content', () => {
            assert.equal(isMeaningfulReviewEntry('Found a bug'), true);
        });
    });

    describe('formatCompletionGateResult', () => {
        it('includes explicit review trust and policy summary lines when provided', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1001',
                status: 'PASSED',
                outcome: 'PASS',
                review_artifacts: {
                    code: {
                        receipt: {
                            trust_level: 'LOCAL_AUDITED'
                        }
                    }
                },
                review_trust_summary: {
                    visible_summary_line: 'Review trust: legacy LOCAL_AUDITED claim via delegated_subagent; treat as local historical evidence, not independent audited review.',
                    policy_summary_line: 'Review policy: asserted local review cannot satisfy mandatory independent review for this code task; use independent reviewer launch attestation or human sign-off.'
                }
            });

            assert.match(output, /Review trust: legacy LOCAL_AUDITED claim/);
            assert.match(output, /Review policy: asserted local review cannot satisfy mandatory independent review for this code task/);
            assert.doesNotMatch(output, /TrustStatus:/);
        });

        it('falls back to compatibility trust rendering when legacy review artifacts are present without a structured trust summary', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1002',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        content: '# Code Review\nREVIEW PASSED',
                        receipt: {
                            trust_level: 'LOCAL_AUDITED',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            reviewer_provenance: {
                                schema_version: 1,
                                attestation_type: 'controller_event_integrity',
                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                                task_sequence: 1,
                                prev_event_sha256: null,
                                event_sha256: 'a'.repeat(64)
                            }
                        }
                    }
                }
            });

            assert.match(output, /Review trust: legacy LOCAL_AUDITED claim via DELEGATED_SUBAGENT/);
            assert.match(output, /Review policy: asserted local review cannot satisfy mandatory independent review for this code task/);
        });

        it('keeps an unavailable trust line visible for partial compatibility review artifacts', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1003',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        content: '# Code Review\nREVIEW PASSED'
                    }
                }
            });

            assert.match(output, /Review trust: unavailable \(required review trust evidence incomplete or invalid\)\./);
            assert.match(output, /Review policy: asserted local review cannot satisfy mandatory independent review for this code task/);
        });

        it('keeps an unavailable trust line visible for receipt-only compatibility review artifacts', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1004',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        receipt: {
                            trust_level: 'LOCAL_ASSERTED',
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-1004',
                            reviewer_fallback_reason: 'provider limitation'
                        }
                    }
                }
            });

            assert.match(output, /Review trust: unavailable \(required review trust evidence incomplete or invalid\)\./);
            assert.match(output, /Review policy: asserted local review cannot satisfy mandatory independent review for this code task/);
        });
    });

    describe('buildReviewTrustSummary', () => {
        it('returns unavailable when required review trust evidence is incomplete', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_provenance: null
                }
            ], 'code', 2);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('does not promote non-canonical independent-looking trust payloads', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'INDEPENDENT_AUDITED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_provenance: {
                        attestation_type: 'provider_artifact'
                    }
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades delegated trust receipts that omit reviewer provenance', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'agent:code-reviewer',
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades trust receipts with invalid execution mode or missing reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_magic',
                    reviewer_identity: null,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades same_agent_fallback trust receipts that omit reviewer_fallback_reason', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'self:T-135',
                    reviewer_fallback_reason: null,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('keeps same_agent_fallback trust receipts unavailable even when legacy policy marked fallback_reason optional', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'self:T-135',
                    reviewer_fallback_reason: null,
                    reviewer_fallback_reason_required: false,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades delegated_subagent trust receipts with self-scoped reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'self:T-135',
                    reviewer_provenance: {
                        attestation_type: 'provider_artifact'
                    }
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades same_agent_fallback trust receipts with agent-scoped reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'agent:code-reviewer',
                    reviewer_fallback_reason: 'provider limitation',
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('accepts valid artifact-only delegated reviewer trust receipts without requiring downstream test evidence', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'security',
                    trust_level: 'LOCAL_AUDITED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'agent:security-reviewer',
                    reviewer_provenance: {
                        schema_version: 1,
                        attestation_type: 'controller_event_integrity',
                        controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                        task_sequence: 5,
                        prev_event_sha256: 'b'.repeat(64),
                        event_sha256: 'c'.repeat(64)
                    }
                }
            ], 'security', 1);

            assert.notEqual(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /LOCAL_AUDITED/);
        });
    });
});
