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
    getReviewFindingsEvidenceFromValidationArtifact,
    validatePreflightForCompletion
} from '../../../../src/gates/completion/completion-verdict';
import type { TimelineEventEntry } from '../../../../src/gates/completion/completion-evidence';
import { buildReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    REVIEW_FINDINGS_SCHEMA_VERSION,
    type ReviewFindingsSeverity
} from '../../../../src/gates/review/review-findings-schema';
import type { LockedReviewFindingPolicyResolution } from '../../../../src/gates/review/review-finding-disposition';
import { buildLegacyReviewFollowUpTaskClosurePolicySnapshot } from '../../../../src/core/review-follow-up-task-closure-policy';

import * as fs from 'node:fs';
import * as path from 'node:path';

function buildAcceptedValidationArtifactWithFinding(severity: ReviewFindingsSeverity) {
    const finding = {
        id: 'F-001',
        title: `${severity} policy finding`,
        description: 'Evidence-bound finding used to verify completion policy disposition behavior.',
        evidence: [
            {
                location: 'src/app.ts:1',
                observation: 'The changed line is covered by the review finding.'
            }
        ],
        coverage_obligation_ids: ['FILE-001']
    };
    return buildReviewFindingsValidationArtifact({
        taskId: 'T-979-policy',
        reviewType: 'code',
        validation: {
            detected: true,
            valid: true,
            violations: [],
            coverage_validation: null,
            report: {
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                task_id: 'T-979-policy',
                review_type: 'code',
                review_context_sha256: 'a'.repeat(64),
                tree_state_sha256: 'b'.repeat(64),
                validation_notes: [
                    {
                        id: 'N-001',
                        topic: 'scope',
                        note: 'Reviewed src/app.ts:1.',
                        evidence: [
                            {
                                location: 'src/app.ts:1',
                                observation: 'Review scope was checked.'
                            }
                        ]
                    }
                ],
                coverage_ledger: {
                    coverage_contract_sha256: 'c'.repeat(64),
                    entries: [
                        {
                            obligation_id: 'FILE-001',
                            evidence: [
                                {
                                    location: 'src/app.ts:1',
                                    observation: 'The changed file was reviewed.'
                                }
                            ],
                            finding_ids: ['F-001']
                        }
                    ]
                },
                findings: {
                    critical: severity === 'critical' ? [finding] : [],
                    high: severity === 'high' ? [finding] : [],
                    medium: severity === 'medium' ? [finding] : [],
                    low: severity === 'low' ? [finding] : []
                },
                residual_risks: [],
                reviewer_notes: []
            }
        },
        reviewOutputSha256: 'd'.repeat(64),
        reviewArtifactPath: '/review.md',
        reviewArtifactSha256: 'e'.repeat(64)
    });
}

function buildAcceptedValidationArtifactWithResidualRisk() {
    return buildReviewFindingsValidationArtifact({
        taskId: 'T-979-policy',
        reviewType: 'code',
        validation: {
            detected: true,
            valid: true,
            violations: [],
            coverage_validation: null,
            report: {
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                task_id: 'T-979-policy',
                review_type: 'code',
                review_context_sha256: 'a'.repeat(64),
                tree_state_sha256: 'b'.repeat(64),
                validation_notes: [
                    {
                        id: 'N-001',
                        topic: 'scope',
                        note: 'Reviewed src/app.ts:1.',
                        evidence: [
                            {
                                location: 'src/app.ts:1',
                                observation: 'Review scope was checked.'
                            }
                        ]
                    }
                ],
                coverage_ledger: {
                    coverage_contract_sha256: 'c'.repeat(64),
                    entries: [
                        {
                            obligation_id: 'FILE-001',
                            evidence: [
                                {
                                    location: 'src/app.ts:1',
                                    observation: 'The changed file was reviewed.'
                                }
                            ],
                            finding_ids: []
                        }
                    ]
                },
                findings: {
                    critical: [],
                    high: [],
                    medium: [],
                    low: []
                },
                residual_risks: [
                    {
                        id: 'R-001',
                        description: 'Evidence-bound residual risk used to verify completion policy disposition behavior.',
                        evidence: [
                            {
                                location: 'src/app.ts:1',
                                observation: 'Residual risk evidence remains linked to the reviewed changed file.'
                            }
                        ]
                    }
                ],
                reviewer_notes: []
            }
        },
        reviewOutputSha256: 'd'.repeat(64),
        reviewArtifactPath: '/review.md',
        reviewArtifactSha256: 'e'.repeat(64)
    });
}

const BALANCED_RECEIPT_POLICY: LockedReviewFindingPolicyResolution = {
    policy: {
        schema_version: 1,
        policy_id: 'balanced',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'create_follow_up',
            low: 'create_follow_up'
        },
        residual_risk: 'create_follow_up'
    },
    base_policy: {
        schema_version: 1,
        policy_id: 'balanced',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'create_follow_up',
            low: 'create_follow_up'
        },
        residual_risk: 'create_follow_up'
    },
    source: 'receipt_review_findings_disposition',
    follow_up_task_closure_policy: buildLegacyReviewFollowUpTaskClosurePolicySnapshot(),
    follow_up_task_closure_policy_source: 'legacy_default',
    diagnostics: []
};

const SOFT_RECEIPT_POLICY: LockedReviewFindingPolicyResolution = {
    policy: {
        schema_version: 1,
        policy_id: 'soft',
        findings: {
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        },
        residual_risk: 'ignore'
    },
    base_policy: {
        schema_version: 1,
        policy_id: 'soft',
        findings: {
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        },
        residual_risk: 'ignore'
    },
    source: 'receipt_review_findings_disposition',
    follow_up_task_closure_policy: buildLegacyReviewFollowUpTaskClosurePolicySnapshot(),
    follow_up_task_closure_policy_source: 'legacy_default',
    diagnostics: []
};

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

        it('preserves every independent finding even when a blocker appears first', () => {
            const lines = [
                '## Findings by Severity',
                '- Critical: `src/first.ts:10` trust boundary bypass; impact: forged evidence; remediation: bind the receipt hash.',
                '- High: `src/later.ts:42` later checklist category is skipped; impact: incomplete review; remediation: finish the category sweep.',
                '- Medium: `tests/later.test.ts:7` remediation review only retests the prior defect; impact: regressions survive; remediation: re-sweep current scope.',
                '## Deferred Findings',
                'none'
            ];

            const section = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.equal(section.length, 3);
            const findings = getFindingsBySeverity(section);
            assert.equal(findings.critical.length, 1);
            assert.equal(findings.high.length, 1);
            assert.equal(findings.medium.length, 1);
            assert.match(findings.high[0], /later checklist category/u);
            assert.match(findings.medium[0], /re-sweep current scope/u);
        });

        it('keeps supported severity subheadings inside Findings by Severity until the next sibling section', () => {
            const lines = [
                '## Findings by Severity',
                '### Medium',
                '- `tests/parser.test.ts:17` covers only inline severity items; impact: nested findings can disappear; remediation: cover severity subheadings.',
                '## Deferred Findings',
                'None'
            ];

            const section = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.deepEqual(section, [
                '### Medium',
                '- `tests/parser.test.ts:17` covers only inline severity items; impact: nested findings can disappear; remediation: cover severity subheadings.'
            ]);
            const findings = getFindingsBySeverity(section);
            assert.equal(findings.medium.length, 1);
            assert.match(findings.medium[0], /nested findings can disappear/u);
        });

        it('keeps supported severity subheadings under non-hash canonical section headings', () => {
            const lines = [
                '**Findings by Severity**',
                '### High',
                '- `src/parser.ts:42` non-hash section heading loses nested finding; impact: direct readers miss failures; remediation: treat canonical headings as section level two.',
                '**Deferred Findings**',
                'None'
            ];

            const section = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.deepEqual(section, [
                '### High',
                '- `src/parser.ts:42` non-hash section heading loses nested finding; impact: direct readers miss failures; remediation: treat canonical headings as section level two.'
            ]);
            const findings = getFindingsBySeverity(section);
            assert.equal(findings.high.length, 1);
            assert.match(findings.high[0], /non-hash section heading/u);
        });

        it('keeps every supported severity subheading under Findings by Severity', () => {
            const lines = [
                '## Findings by Severity',
                '### Critical',
                '- `src/critical.ts:1` critical finding; impact: critical issue; remediation: fix critical issue.',
                '### High',
                '- `src/high.ts:2` high finding; impact: high issue; remediation: fix high issue.',
                '### Medium',
                '- `src/medium.ts:3` medium finding; impact: medium issue; remediation: fix medium issue.',
                '### Low',
                '- `src/low.ts:4` low finding; impact: low issue; remediation: fix low issue.',
                '## Deferred Findings',
                'None'
            ];

            const section = extractMarkdownSectionLines(lines, 'Findings by Severity');
            const findings = getFindingsBySeverity(section);
            assert.equal(findings.critical.length, 1);
            assert.equal(findings.high.length, 1);
            assert.equal(findings.medium.length, 1);
            assert.equal(findings.low.length, 1);
            assert.match(findings.critical[0], /critical finding/u);
            assert.match(findings.high[0], /high finding/u);
            assert.match(findings.medium[0], /medium finding/u);
            assert.match(findings.low[0], /low finding/u);
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

        it('parses canonical None and multiple parser-supported severity formats', () => {
            const emptyFindings = getFindingsBySeverity(['None']);
            assert.deepEqual(emptyFindings, { critical: [], high: [], medium: [], low: [] });

            const findings = getFindingsBySeverity([
                '- High: `src/parser.ts:42` drops the second finding; impact: incomplete review; remediation: keep every entry.',
                '### Medium',
                '- `tests/parser.test.ts:17` covers only the first severity; impact: regression can hide; remediation: assert every severity bucket.',
                '- `tests/parser.test.ts:33` omits list-format coverage; impact: reviewer output can regress; remediation: add list-format fixture.',
                '### Low',
                '- None'
            ]);

            assert.equal(findings.high.length, 1);
            assert.equal(findings.medium.length, 2);
            assert.equal(findings.low.length, 0);
            assert.match(findings.high[0], /drops the second finding/u);
            assert.match(findings.medium[0], /covers only the first severity/u);
            assert.match(findings.medium[1], /omits list-format coverage/u);
        });

        it('parses every supported severity subheading', () => {
            const expectedSeverities = ['critical', 'high', 'medium', 'low'] as const;
            const lines = expectedSeverities.flatMap((severity) => [
                `### ${severity[0].toUpperCase()}${severity.slice(1)}`,
                `- \`src/${severity}.ts:1\` ${severity} subheading finding; impact: ${severity} issue; remediation: fix ${severity} issue.`
            ]);

            const findings = getFindingsBySeverity(lines);

            for (const severity of expectedSeverities) {
                assert.equal(findings[severity].length, 1, severity);
                assert.match(findings[severity][0], new RegExp(`${severity} subheading finding`, 'u'));
            }
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
            assert.equal(result.status, 'PASS', result.violations.join('\n'));
            assert.equal(result.violations.length, 0);
        });

        it('accepts findings JSON artifacts with no active findings or residual risks', () => {
            const content = JSON.stringify({
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                task_id: 'T-979-2',
                review_type: 'code',
                review_context_sha256: 'a'.repeat(64),
                tree_state_sha256: 'b'.repeat(64),
                validation_notes: [
                    {
                        id: 'N-001',
                        topic: 'scope',
                        note: 'Reviewed src/gates/review-context/review-context-artifacts.ts:234 for JSON output template generation.',
                        evidence: [
                            {
                                location: 'src/gates/review-context/review-context-artifacts.ts:234',
                                observation: 'The output template is JSON-only.'
                            }
                        ]
                    }
                ],
                coverage_ledger: {
                    coverage_contract_sha256: 'c'.repeat(64),
                    entries: [
                        {
                            obligation_id: 'FILE-001',
                            evidence: [
                                {
                                    location: 'src/gates/review-context/review-context-artifacts.ts:234',
                                    observation: 'The changed file was reviewed.'
                                }
                            ],
                            finding_ids: []
                        }
                    ]
                },
                review_execution: {
                    mode: 'FULL',
                    contract_sha256: 'd'.repeat(64),
                    covered_delta_targets: [],
                    inspected_prior_finding_ids: []
                },
                findings: { critical: [], high: [], medium: [], low: [] },
                residual_risks: [],
                reviewer_notes: []
            });

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'PASS', result.violations.join('\n'));
            assert.equal(result.findings_section_present, true);
            assert.equal(result.residual_risks_section_present, true);
            assert.deepEqual(result.findings_by_severity, { critical: [], high: [], medium: [], low: [] });
            assert.equal(result.violations.length, 0);
        });

        it('rejects malformed findings JSON instead of treating it as a clean pass', () => {
            const content = JSON.stringify({
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                findings: {}
            });

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'FAILED');
            assert.equal(result.findings_section_present, true);
            assert.equal(result.residual_risks_section_present, true);
            const diagnostic = result.violations.join('\n');
            assert.match(diagnostic, /malformed findings JSON/u);
            assert.match(diagnostic, /task_id is required/u);
            assert.match(diagnostic, /coverage_ledger must be an object/u);
            assert.match(diagnostic, /findings\.critical must be an array/u);
        });

        it('keeps active findings visible in findings JSON artifacts', () => {
            const content = JSON.stringify({
                schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
                task_id: 'T-979-2',
                review_type: 'code',
                review_context_sha256: 'a'.repeat(64),
                tree_state_sha256: 'b'.repeat(64),
                validation_notes: [
                    {
                        id: 'N-001',
                        topic: 'scope',
                        note: 'Reviewed src/cli/commands/gate-review-handlers/result/review-result-handlers.ts:621.',
                        evidence: [
                            {
                                location: 'src/cli/commands/gate-review-handlers/result/review-result-handlers.ts:621',
                                observation: 'The JSON artifact remains canonical.'
                            }
                        ]
                    }
                ],
                coverage_ledger: {
                    coverage_contract_sha256: 'c'.repeat(64),
                    entries: [
                        {
                            obligation_id: 'FILE-001',
                            evidence: [
                                {
                                    location: 'src/cli/commands/gate-review-handlers/result/review-result-handlers.ts:621',
                                    observation: 'The changed file was reviewed.'
                                }
                            ],
                            finding_ids: ['F-001']
                        }
                    ]
                },
                review_execution: {
                    mode: 'FULL',
                    contract_sha256: 'd'.repeat(64),
                    covered_delta_targets: [],
                    inspected_prior_finding_ids: []
                },
                findings: {
                    critical: [],
                    high: [
                        {
                            id: 'F-001',
                            title: 'JSON artifact lifecycle reader regression',
                            description: 'Downstream readers must not require Markdown sections for schema v1 JSON review artifacts.',
                            evidence: [
                                {
                                    location: 'src/gates/completion/completion-verdict-findings.ts:33',
                                    observation: 'The lifecycle evidence reader owns active finding extraction.'
                                }
                            ],
                            coverage_obligation_ids: ['FILE-001']
                        }
                    ],
                    medium: [],
                    low: []
                },
                residual_risks: [],
                reviewer_notes: []
            });

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'FAILED');
            assert.equal(
                result.findings_by_severity.high.length,
                1,
                result.violations.join('\n')
            );
            assert.match(result.findings_by_severity.high[0], /F-001/u);
            assert.match(result.violations.join('\n'), /active High findings/u);
        });

        it('accepts policy-dispositioned non-blocking findings validation artifacts at completion', () => {
            const artifact = buildAcceptedValidationArtifactWithFinding('low');

            const result = getReviewFindingsEvidenceFromValidationArtifact(
                '/review.md',
                artifact,
                BALANCED_RECEIPT_POLICY
            );

            assert.equal(result.status, 'PASS');
            assert.equal(result.findings_by_severity.low.length, 1);
            assert.match(result.findings_by_severity.low[0], /F-001/u);
            assert.equal(result.violations.length, 0);
        });

        it('accepts evidence-only F-000 at completion even under a blocking severity', () => {
            const artifact = buildAcceptedValidationArtifactWithFinding('high');
            const finding = artifact.validation_result.normalized_inventory.findings_by_severity.high[0];
            finding.id = 'F-000';
            finding.title = '[garda:evidence-only:missing-focused-validation] test=tests/node/example.test.ts; action=run-and-record-focused-test';
            finding.description = 'The isolated reviewer could not execute the focused command.';

            const result = getReviewFindingsEvidenceFromValidationArtifact(
                '/review.md',
                artifact,
                BALANCED_RECEIPT_POLICY
            );

            assert.equal(result.status, 'PASS');
            assert.equal(result.findings_by_severity.high.length, 1);
            assert.match(result.findings_by_severity.high[0], /F-000/u);
            assert.equal(result.violations.length, 0);
        });

        it('accepts policy-dispositioned non-blocking residual risks validation artifacts at completion', () => {
            const artifact = buildAcceptedValidationArtifactWithResidualRisk();

            const result = getReviewFindingsEvidenceFromValidationArtifact(
                '/review.md',
                artifact,
                BALANCED_RECEIPT_POLICY
            );

            assert.equal(result.status, 'PASS');
            assert.equal(result.residual_risks.length, 1);
            assert.match(result.residual_risks[0], /R-001/u);
            assert.equal(result.violations.length, 0);
        });

        it('accepts ignored residual risks validation artifacts at completion', () => {
            const artifact = buildAcceptedValidationArtifactWithResidualRisk();

            const result = getReviewFindingsEvidenceFromValidationArtifact(
                '/review.md',
                artifact,
                SOFT_RECEIPT_POLICY
            );

            assert.equal(result.status, 'PASS');
            assert.equal(result.residual_risks.length, 1);
            assert.match(result.residual_risks[0], /R-001/u);
            assert.equal(result.violations.length, 0);
        });

        it('rejects policy-blocking findings validation artifacts at completion', () => {
            const artifact = buildAcceptedValidationArtifactWithFinding('high');

            const result = getReviewFindingsEvidenceFromValidationArtifact(
                '/review.md',
                artifact,
                BALANCED_RECEIPT_POLICY
            );

            assert.equal(result.status, 'FAILED');
            assert.equal(result.findings_by_severity.high.length, 1);
            assert.match(result.violations.join('\n'), /fix_now High findings/u);
        });

        it('passes canonical None reports', () => {
            const content = [
                '# Review',
                '## Findings by Severity',
                'None',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'PASS');
            assert.deepEqual(result.findings_by_severity, { critical: [], high: [], medium: [], low: [] });
            assert.deepEqual(result.deferred_findings, []);
            assert.deepEqual(result.residual_risks, []);
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

        it('keeps parser-supported severity subheading findings active and visible', () => {
            const content = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/parser.ts:42` and `tests/parser.test.ts:17` for severity finding parsing.',
                '## Findings by Severity',
                '### Medium',
                '- `src/parser.ts:42` this finding is hidden behind an unsupported nested heading.',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW FAILED'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'FAILED');
            assert.equal(result.findings_by_severity.medium.length, 1);
            assert.match(result.findings_by_severity.medium[0], /unsupported nested heading/u);
            const diagnostic = result.violations.join('\n');
            assert.doesNotMatch(diagnostic, /unsupported severity heading '### Medium'/u);
            assert.match(diagnostic, /active Medium findings/u);
        });

        it('keeps every supported severity subheading active in findings evidence', () => {
            const content = [
                '# Review',
                '**Validation Notes**',
                'Reviewed all severity subheading parser paths in `src/parser.ts:42` and `tests/parser.test.ts:17`.',
                '**Findings by Severity**',
                '### Critical',
                '- `src/critical.ts:1` critical subheading finding; impact: critical issue; remediation: fix critical issue.',
                '### High',
                '- `src/high.ts:2` high subheading finding; impact: high issue; remediation: fix high issue.',
                '### Medium',
                '- `src/medium.ts:3` medium subheading finding; impact: medium issue; remediation: fix medium issue.',
                '### Low',
                '- `src/low.ts:4` low subheading finding; impact: low issue; remediation: fix low issue.',
                '**Deferred Findings**',
                'None',
                '**Residual Risks**',
                'None',
                '**Verdict**',
                'REVIEW FAILED'
            ].join('\n');

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'FAILED');
            assert.equal(result.findings_by_severity.critical.length, 1);
            assert.equal(result.findings_by_severity.high.length, 1);
            assert.equal(result.findings_by_severity.medium.length, 1);
            assert.equal(result.findings_by_severity.low.length, 1);
            const diagnostic = result.violations.join('\n');
            assert.match(diagnostic, /active Critical findings/u);
            assert.match(diagnostic, /active High findings/u);
            assert.match(diagnostic, /active Medium findings/u);
            assert.match(diagnostic, /active Low findings/u);
        });

        it('does not scan unsupported severity headings beyond the Findings section boundary', () => {
            const content = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/parser.ts:42` and `tests/parser.test.ts:17` for findings section boundaries.',
                '## Findings by Severity',
                'None',
                '## Implementation Notes',
                '### High outside findings',
                '- This is not part of Findings by Severity and must not be parsed as review finding evidence.',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'PASS');
            assert.deepEqual(result.findings_by_severity, { critical: [], high: [], medium: [], low: [] });
            assert.doesNotMatch(result.violations.join('\n'), /unsupported severity heading '### High outside findings'/u);
        });

        it('rejects bare supported severity subheadings without a finding', () => {
            const content = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/parser.ts:42` and `tests/parser.test.ts:17` for bare severity subheading parsing.',
                '## Findings by Severity',
                '### High',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');

            const result = getReviewArtifactFindingsEvidence('/review.md', content);

            assert.equal(result.status, 'FAILED');
            assert.deepEqual(result.findings_by_severity, { critical: [], high: [], medium: [], low: [] });
            const diagnostic = result.violations.join('\n');
            assert.match(diagnostic, /unsupported meaningful content '### High'/u);
            assert.match(diagnostic, /'### Medium' followed by '- <finding>'/u);
        });

        it('rejects unadvertised severity subheading variants', () => {
            const inlineHeadingContent = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/parser.ts:42` and `tests/parser.test.ts:17` for strict severity subheading shape.',
                '## Findings by Severity',
                '### High: `src/parser.ts:42` inline heading finding should be rejected.',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW FAILED'
            ].join('\n');
            const deeperHeadingContent = inlineHeadingContent.replace(
                '### High: `src/parser.ts:42` inline heading finding should be rejected.',
                '#### High'
            );

            const inlineResult = getReviewArtifactFindingsEvidence('/review-inline.md', inlineHeadingContent);
            const deeperResult = getReviewArtifactFindingsEvidence('/review-deeper.md', deeperHeadingContent);

            assert.equal(inlineResult.status, 'FAILED');
            assert.match(inlineResult.violations.join('\n'), /unsupported severity heading '### High:/u);
            assert.equal(deeperResult.status, 'FAILED');
            assert.match(deeperResult.violations.join('\n'), /unsupported severity heading '#### High'/u);
        });

        it('rejects malformed severity headings with permitted-format diagnostic', () => {
            const content = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/parser.ts:42` and `tests/parser.test.ts:17` for malformed severity heading parsing.',
                '## Findings by Severity',
                '### Medium finding without colon',
                '- `src/parser.ts:42` this finding is hidden behind a malformed nested heading.',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW FAILED'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'FAILED');
            const diagnostic = result.violations.join('\n');
            assert.match(diagnostic, /unsupported severity heading '### Medium finding without colon'/u);
            assert.match(diagnostic, /- Medium: <file:line>/u);
            assert.match(diagnostic, /'Medium:' followed by '- <finding>'/u);
            assert.match(diagnostic, /'### Medium' followed by '- <finding>'/u);
            assert.match(diagnostic, /canonical 'None'/u);
        });

        it('rejects meaningful findings content that is not owned by parser-supported severity syntax', () => {
            const content = [
                '# Review',
                '## Validation Notes',
                'Reviewed `src/auth.ts:42` and `tests/auth.test.ts:17` for untrusted findings parsing.',
                '## Findings by Severity',
                'Medium',
                '- `src/auth.ts:42` auth bypass is hidden behind a bare severity label.',
                'Plain prose finding in `src/parser.ts:12` is also not parser-supported.',
                '## Deferred Findings',
                'None',
                '## Residual Risks',
                'None',
                '## Verdict',
                'REVIEW FAILED'
            ].join('\n');
            const result = getReviewArtifactFindingsEvidence('/review.md', content);
            assert.equal(result.status, 'FAILED');
            const diagnostic = result.violations.join('\n');
            assert.match(diagnostic, /unsupported meaningful content 'Medium'/u);
            assert.match(diagnostic, /unsupported meaningful content '- `src\/auth\.ts:42` auth bypass/u);
            assert.match(diagnostic, /unsupported meaningful content 'Plain prose finding in `src\/parser\.ts:12`/u);
            assert.match(diagnostic, /bare severity labels, and bullets without a severity owner are rejected/u);
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
