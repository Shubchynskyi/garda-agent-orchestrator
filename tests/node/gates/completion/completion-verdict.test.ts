import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    STAGE_SEQUENCE_ORDER,
    NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER,
    REVIEW_CONTRACTS,
    EMPTY_REVIEW_MARKERS,
    validateStageSequence,
    validateZeroDiffCompletionEvidence,
    isTrivialReview,
    extractMarkdownSectionLines,
    normalizeReviewListText,
    isMeaningfulReviewEntry,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity,
    getReviewArtifactFindingsEvidence,
    validatePreflightForCompletion
} from '../../../../src/gates/completion/completion-verdict';
import type { TimelineEventEntry } from '../../../../src/gates/completion/completion-evidence';

import * as fs from 'node:fs';
import * as path from 'node:path';

describe('gates/completion-verdict', () => {
    describe('STAGE_SEQUENCE_ORDER constants', () => {
        it('exports the canonical stage sequence', () => {
            assert.ok(Array.isArray(STAGE_SEQUENCE_ORDER));
            assert.ok(STAGE_SEQUENCE_ORDER.length > 0);
            assert.equal(STAGE_SEQUENCE_ORDER[0], 'TASK_MODE_ENTERED');
            assert.equal(STAGE_SEQUENCE_ORDER[STAGE_SEQUENCE_ORDER.length - 1], 'REVIEW_GATE_PASSED');
            assert.ok(STAGE_SEQUENCE_ORDER.includes('REVIEW_RECORDED'));
        });

        it('NO_REVIEW_RECORDED excludes REVIEW_RECORDED', () => {
            assert.ok(!NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER.includes('REVIEW_RECORDED'));
            assert.ok(!NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER.includes('REVIEW_PHASE_STARTED'));
            assert.equal(
                NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER.length,
                STAGE_SEQUENCE_ORDER.length - 2
            );
        });

        it('NON_CODE_STAGE_SEQUENCE_ORDER equals NO_REVIEW_RECORDED', () => {
            assert.deepEqual(NON_CODE_STAGE_SEQUENCE_ORDER, NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER);
        });
    });

    describe('REVIEW_CONTRACTS', () => {
        it('includes standard review types', () => {
            const keys = REVIEW_CONTRACTS.map(([key]) => key);
            assert.ok(keys.includes('code'));
            assert.ok(keys.includes('test'));
            assert.ok(keys.includes('refactor'));
            assert.ok(keys.includes('security'));
        });
    });

    describe('EMPTY_REVIEW_MARKERS', () => {
        it('recognizes standard empty markers', () => {
            assert.ok(EMPTY_REVIEW_MARKERS.has('none'));
            assert.ok(EMPTY_REVIEW_MARKERS.has('n/a'));
            assert.ok(EMPTY_REVIEW_MARKERS.has('no findings'));
            assert.ok(!EMPTY_REVIEW_MARKERS.has('actual finding'));
        });
    });

    describe('validateStageSequence', () => {
        function makeEvent(eventType: string, seq: number): TimelineEventEntry {
            return { event_type: eventType, timestamp_utc: '2026-01-01T00:00:00Z', sequence: seq, details: null };
        }

        it('passes for a valid complete sequence', () => {
            const events: TimelineEventEntry[] = [
                makeEvent('TASK_MODE_ENTERED', 0),
                makeEvent('HANDSHAKE_DIAGNOSTICS_RECORDED', 1),
                makeEvent('SHELL_SMOKE_PREFLIGHT_RECORDED', 2),
                makeEvent('PREFLIGHT_CLASSIFIED', 3),
                makeEvent('IMPLEMENTATION_STARTED', 4),
                makeEvent('COMPILE_GATE_PASSED', 5),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('REVIEW_RECORDED', 7),
                makeEvent('REVIEW_GATE_PASSED', 8)
            ];
            const result = validateStageSequence(events, true, '/timeline.jsonl', true);
            assert.equal(result.violations.length, 0);
            assert.equal(result.code_changed, true);
            assert.deepEqual(result.observed_order, [...STAGE_SEQUENCE_ORDER]);
        });

        it('reports violation for missing PREFLIGHT_CLASSIFIED on code-changing task', () => {
            const events: TimelineEventEntry[] = [
                makeEvent('TASK_MODE_ENTERED', 0),
                makeEvent('HANDSHAKE_DIAGNOSTICS_RECORDED', 1),
                makeEvent('SHELL_SMOKE_PREFLIGHT_RECORDED', 2),
                makeEvent('IMPLEMENTATION_STARTED', 3),
                makeEvent('COMPILE_GATE_PASSED', 4),
                makeEvent('REVIEW_PHASE_STARTED', 5),
                makeEvent('REVIEW_RECORDED', 6),
                makeEvent('REVIEW_GATE_PASSED', 7)
            ];
            const result = validateStageSequence(events, true, '/timeline.jsonl', true);
            assert.ok(result.violations.length > 0);
            assert.ok(result.violations.some(v => v.includes('PREFLIGHT_CLASSIFIED')));
        });

        it('skips REVIEW_RECORDED check when reviewRecordedRequired is false', () => {
            const events: TimelineEventEntry[] = [
                makeEvent('TASK_MODE_ENTERED', 0),
                makeEvent('HANDSHAKE_DIAGNOSTICS_RECORDED', 1),
                makeEvent('SHELL_SMOKE_PREFLIGHT_RECORDED', 2),
                makeEvent('PREFLIGHT_CLASSIFIED', 3),
                makeEvent('IMPLEMENTATION_STARTED', 4),
                makeEvent('COMPILE_GATE_PASSED', 5),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('REVIEW_GATE_PASSED', 7)
            ];
            const result = validateStageSequence(events, true, '/timeline.jsonl', false);
            assert.equal(result.violations.length, 0);
        });

        it('detects out-of-order events', () => {
            const events: TimelineEventEntry[] = [
                makeEvent('TASK_MODE_ENTERED', 0),
                makeEvent('HANDSHAKE_DIAGNOSTICS_RECORDED', 1),
                makeEvent('SHELL_SMOKE_PREFLIGHT_RECORDED', 2),
                makeEvent('COMPILE_GATE_PASSED', 3),
                makeEvent('PREFLIGHT_CLASSIFIED', 4),
                makeEvent('IMPLEMENTATION_STARTED', 5),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('REVIEW_GATE_PASSED', 7)
            ];
            const result = validateStageSequence(events, true, '/timeline.jsonl', false);
            assert.ok(result.violations.length > 0);
            assert.ok(result.violations.some(v => v.includes('appears before')));
        });
    });

    describe('validateZeroDiffCompletionEvidence', () => {
        it('returns NOT_APPLICABLE when diff is present', () => {
            const preflight = { metrics: { changed_lines_total: 50 }, changed_files: ['a.ts'] };
            const noOpEvidence = { evidence_status: 'NOT_FOUND', evidence_path: null, classification: null, reason: null };
            const result = validateZeroDiffCompletionEvidence(preflight, 'T-001', 'Test task', noOpEvidence as any);
            assert.equal(result.status, 'NOT_APPLICABLE');
            assert.equal(result.zero_diff_detected, false);
            assert.equal(result.violations.length, 0);
        });

        it('returns REQUIRES_AUDITED_NO_OP when zero-diff without no-op evidence', () => {
            const preflight = { metrics: { changed_lines_total: 0 }, changed_files: [] };
            const noOpEvidence = { evidence_status: 'NOT_FOUND', evidence_path: '/path/no-op.json', classification: null, reason: null };
            const result = validateZeroDiffCompletionEvidence(preflight, 'T-001', 'Test task', noOpEvidence as any);
            assert.equal(result.status, 'REQUIRES_AUDITED_NO_OP');
            assert.equal(result.zero_diff_detected, true);
            assert.ok(result.violations.length > 0);
        });

        it('returns SATISFIED_BY_AUDITED_NO_OP when zero-diff with passing no-op', () => {
            const preflight = { metrics: { changed_lines_total: 0 }, changed_files: [] };
            const noOpEvidence = { evidence_status: 'PASS', evidence_path: '/path/no-op.json', classification: 'scope_narrowed', reason: 'Task already done' };
            const result = validateZeroDiffCompletionEvidence(preflight, 'T-001', 'Test task', noOpEvidence as any);
            assert.equal(result.status, 'SATISFIED_BY_AUDITED_NO_OP');
            assert.equal(result.zero_diff_detected, true);
            assert.equal(result.violations.length, 0);
        });
    });

    describe('isTrivialReview', () => {
        it('flags very short content as trivial', () => {
            assert.equal(isTrivialReview('LGTM'), true);
            assert.equal(isTrivialReview(''), true);
        });

        it('accepts substantive content', () => {
            const content = [
                '# Code Review',
                '## Findings by Severity',
                '- Critical: None',
                '- High: None',
                '- Medium: None',
                '- Low: None',
                '## Residual Risks',
                '- None',
                '',
                'The implementation correctly extracts the `completion-verdict.ts` module from `completion.ts`.',
                'All existing tests pass and the refactoring preserves the exact same behavior.',
                'Reference paths: `src/gates/completion-verdict.ts:42`, `src/gates/completion.ts:55`.',
                'Method signatures and return types are unchanged.'
            ].join('\n');
            assert.equal(isTrivialReview(content), false);
        });
    });

    describe('extractMarkdownSectionLines', () => {
        it('extracts lines from a section by heading', () => {
            const lines = [
                '## Summary',
                'Some summary content.',
                '## Findings by Severity',
                '- Critical: None',
                '- High: Issue found',
                '## Residual Risks',
                '- None'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.deepEqual(result, ['- Critical: None', '- High: Issue found']);
        });

        it('returns empty array when heading not found', () => {
            const lines = ['## Summary', 'Content here.'];
            assert.deepEqual(extractMarkdownSectionLines(lines, 'Missing Section'), []);
        });
    });

    describe('normalizeReviewListText', () => {
        it('strips bullets and backticks', () => {
            assert.equal(normalizeReviewListText('- `some finding`'), 'some finding');
            assert.equal(normalizeReviewListText('* important item'), 'important item');
            assert.equal(normalizeReviewListText('1. numbered'), 'numbered');
        });

        it('handles null/undefined', () => {
            assert.equal(normalizeReviewListText(null), '');
            assert.equal(normalizeReviewListText(undefined), '');
        });
    });

    describe('isMeaningfulReviewEntry', () => {
        it('treats empty markers as not meaningful', () => {
            assert.equal(isMeaningfulReviewEntry('None'), false);
            assert.equal(isMeaningfulReviewEntry('NONE'), false);
            assert.equal(isMeaningfulReviewEntry('n/a'), false);
            assert.equal(isMeaningfulReviewEntry('No findings'), false);
            assert.equal(isMeaningfulReviewEntry('None significant for the scoped remediation; current tests exercise the changed review-output paths adequately.'), false);
        });

        it('treats real findings as meaningful', () => {
            assert.equal(isMeaningfulReviewEntry('Missing null check on line 42'), true);
            assert.equal(isMeaningfulReviewEntry('None significant, but the authentication fallback still needs a follow-up fix.'), true);
        assert.equal(isMeaningfulReviewEntry('None significant, action required before release.'), true);
        assert.equal(isMeaningfulReviewEntry('None significant, pending owner decision.'), true);
        assert.equal(isMeaningfulReviewEntry('None significant for the scoped remediation; verify release notes.'), true);
        assert.equal(
            isMeaningfulReviewEntry('None significant for the scoped remediation; current tests exercise uncovered a flaky auth path needing fix'),
            true
        );
        });
    });

    describe('getMarkdownMeaningfulEntries', () => {
        it('collects meaningful bullet entries', () => {
            const lines = [
                '- None',
                '- Found issue in `parser.ts`',
                '- N/A'
            ];
            const entries = getMarkdownMeaningfulEntries(lines);
            assert.equal(entries.length, 1);
            assert.ok(entries[0].includes('parser.ts'));
        });

        it('filters common no-risk prose without hiding active risks', () => {
            assert.deepEqual(getMarkdownMeaningfulEntries([
                'None significant for the scoped remediation; current tests exercise the changed review-output paths adequately.',
                'NONE',
                'No material residual risks.'
            ]), []);
            assert.deepEqual(getMarkdownMeaningfulEntries([
                'None significant, but the authentication fallback still needs a follow-up fix.'
            ]), ['None significant, but the authentication fallback still needs a follow-up fix.']);
        assert.deepEqual(getMarkdownMeaningfulEntries([
            'None significant, pending owner decision.'
        ]), ['None significant, pending owner decision.']);
        assert.deepEqual(getMarkdownMeaningfulEntries([
            'None significant for the scoped remediation; investigate release behavior.'
        ]), ['None significant for the scoped remediation; investigate release behavior.']);
        assert.deepEqual(getMarkdownMeaningfulEntries([
            'None significant for the scoped remediation; current tests exercise uncovered a flaky auth path needing fix'
        ]), ['None significant for the scoped remediation; current tests exercise uncovered a flaky auth path needing fix']);
        });
    });

    describe('getFindingsBySeverity', () => {
        it('parses severity-grouped findings', () => {
            const lines = [
                '- Critical: None',
                '- High: Memory leak in `cache.ts`',
                '- Medium: None',
                '- Low: Minor style issue'
            ];
            const findings = getFindingsBySeverity(lines);
            assert.equal(findings.critical.length, 0);
            assert.equal(findings.high.length, 1);
            assert.ok(findings.high[0].includes('Memory leak'));
            assert.equal(findings.medium.length, 0);
            assert.equal(findings.low.length, 1);
        });
    });

    describe('getReviewArtifactFindingsEvidence', () => {
        it('reports missing required sections', () => {
            const result = getReviewArtifactFindingsEvidence('/review.md', '# Review\nLooks good.');
            assert.equal(result.status, 'FAILED');
            assert.ok(result.missing_sections.includes('Findings by Severity'));
            assert.ok(result.missing_sections.includes('Residual Risks'));
        });

        it('passes when all sections present with no active findings', () => {
            const content = [
                '# Review',
                '## Findings by Severity',
                '- Critical: None',
                '- High: None',
                '- Medium: None',
                '- Low: None',
                '## Residual Risks',
                '- None'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'PASS');
            assert.equal(result.violations.length, 0);
        });

        it('rejects ambiguous duplicate section headings after normalization', () => {
            const content = [
                '# Review',
                '## Findings by Severity',
                'none',
                '**Findings by Severity**',
                'none',
                '## Residual Risks',
                'none'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry) => entry.includes("ambiguous duplicate section heading for '## Findings by Severity'")));
        });
    });

    describe('validatePreflightForCompletion', () => {
        it('validates a valid preflight artifact', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cv-'));
            const preflightPath = path.join(tmpDir, 'preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-001', changed_files: ['a.ts'] }), 'utf8');
            const result = validatePreflightForCompletion(preflightPath, 'T-001');
            assert.equal(result.resolved_task_id, 'T-001');
            assert.equal(result.errors.length, 0);
            fs.rmSync(tmpDir, { recursive: true });
        });

        it('reports task-id mismatch', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cv-'));
            const preflightPath = path.join(tmpDir, 'preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-002', changed_files: [] }), 'utf8');
            const result = validatePreflightForCompletion(preflightPath, 'T-001');
            assert.ok(result.errors.some(e => e.includes('does not match')));
            fs.rmSync(tmpDir, { recursive: true });
        });

        it('throws on invalid JSON', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cv-'));
            const preflightPath = path.join(tmpDir, 'preflight.json');
            fs.writeFileSync(preflightPath, 'NOT JSON', 'utf8');
            assert.throws(() => validatePreflightForCompletion(preflightPath, 'T-001'), /not valid JSON/);
            fs.rmSync(tmpDir, { recursive: true });
        });
    });

    describe('re-export equivalence from completion.ts hub', () => {
        it('completion.ts re-exports all verdict symbols', async () => {
            const completionModule = await import('../../../../src/gates/completion');
            assert.strictEqual(completionModule.STAGE_SEQUENCE_ORDER, STAGE_SEQUENCE_ORDER);
            assert.strictEqual(completionModule.NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER, NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER);
            assert.strictEqual(completionModule.NON_CODE_STAGE_SEQUENCE_ORDER, NON_CODE_STAGE_SEQUENCE_ORDER);
            assert.strictEqual(completionModule.validateStageSequence, validateStageSequence);
            assert.strictEqual(completionModule.validateZeroDiffCompletionEvidence, validateZeroDiffCompletionEvidence);
            assert.strictEqual(completionModule.isTrivialReview, isTrivialReview);
            assert.strictEqual(completionModule.extractMarkdownSectionLines, extractMarkdownSectionLines);
            assert.strictEqual(completionModule.validatePreflightForCompletion, validatePreflightForCompletion);
        });
    });
});
