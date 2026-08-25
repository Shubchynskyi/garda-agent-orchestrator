import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatFinalUserReport, type FinalCloseoutArtifact } from '../../../../src/gates/task-audit/task-audit-summary';

const TASK_ID = 'T-AUDIT-1';

function makeFinalUserReportTimingEntry(
    reviewType: string,
    durationMs: number | null,
    overrides: Partial<NonNullable<FinalCloseoutArtifact['review_timing_audit']>['entries'][number]> = {}
): NonNullable<FinalCloseoutArtifact['review_timing_audit']>['entries'][number] {
    return {
        review_type: reviewType,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        reviewer_execution_mode: 'delegated_subagent',
        reused_existing_review: false,
        receipt_path: `runtime/reviews/${TASK_ID}-${reviewType}-receipt.json`,
        receipt_sha256: null,
        review_output_path: null,
        review_output_sha256: null,
        provider: 'Codex',
        provider_invocation_id: `codex-${reviewType}-run`,
        reviewer_launch_attestation_source: 'codex.spawn_agent',
        launch_prepared_at_utc: null,
        delegation_started_at_utc: null,
        launched_at_utc: null,
        launch_completed_at_utc: null,
        invocation_attested_at_utc: null,
        review_result_recorded_at_utc: null,
        review_output_source_mtime_utc: null,
        delegation_to_result_ms: durationMs,
        delegation_to_source_mtime_ms: null,
        gate_finalize_ms: null,
        launch_to_result_ms: durationMs,
        launch_to_source_mtime_ms: null,
        hidden_timing_status: 'TRUSTED',
        hidden_timing_distrust_code: null,
        ...overrides
    };
}

type FinalUserReportCloseoutOverrides = Partial<Omit<
    FinalCloseoutArtifact,
    'artifact_paths' | 'implementation_summary' | 'review_integrity_attestation' | 'docs'
>> & {
    artifact_paths?: Partial<FinalCloseoutArtifact['artifact_paths']>;
    implementation_summary?: Partial<FinalCloseoutArtifact['implementation_summary']>;
    review_integrity_attestation?: Partial<NonNullable<FinalCloseoutArtifact['review_integrity_attestation']>>;
    docs?: Partial<FinalCloseoutArtifact['docs']>;
};

function makeFinalUserReportCloseout(overrides: FinalUserReportCloseoutOverrides = {}): FinalCloseoutArtifact {
    const base: FinalCloseoutArtifact = {
        schema_version: 1,
        event_source: 'task-audit-summary',
        task_id: TASK_ID,
        generated_utc: '2026-01-01T00:00:00.000Z',
        audit_status: 'PASS',
        status: 'READY',
        blocker: null,
        artifact_state: 'MATERIALIZED',
        artifact_paths: {
            json: `runtime/reviews/${TASK_ID}-final-closeout.json`,
            markdown: `runtime/reviews/${TASK_ID}-final-closeout.md`,
            final_user_report: `runtime/reviews/${TASK_ID}-final-user-report.md`
        },
        implementation_summary: {
            requested_depth: 2,
            effective_depth: 2,
            path_mode: 'FULL_PATH',
            review_verdicts: { code: 'REVIEW PASSED' },
            docs_updated: false,
            changed_files_count: 1,
            changed_lines_total: 8,
            scope_category: 'code',
            active_profile: 'balanced'
        },
        review_timing_audit: {
            entries: [makeFinalUserReportTimingEntry('code', 65_000)],
            visible_summary_line: 'Review timing audit: code(TRUSTED).'
        },
        review_integrity_attestation: {
            schema_version: 1,
            enforcement_mode: 'BLOCKING',
            status: 'INDEPENDENT_REVIEW_ATTESTED',
            required_review_count: 1,
            required_review_types: ['code'],
            independent_review_completed: true,
            completion_review_attested: true,
            completion_review_attestation_not_required: false,
            completion_allowed: true,
            fake_or_fallback_artifacts_observed: false,
            same_agent_fallback_observed: false,
            fallback_artifacts_observed: false,
            legacy_local_review_observed: false,
            missing_or_unverifiable_artifacts_observed: false,
            fabricated_artifacts_observed: false,
            observed_issues: [],
            reason: 'All mandatory reviews are independently audited.',
            visible_summary_line: 'Review integrity: INDEPENDENT_REVIEW_ATTESTED.',
            final_report_lines: []
        },
        workflow: {
            mandatory_full_suite_enabled: false,
            visible_summary_line: 'Mandatory full-suite: false'
        },
        docs: {
            decision: 'NO_DOC_UPDATES',
            behavior_changed: false,
            changelog_updated: false,
            docs_updated: []
        },
        token_economy: null,
        commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
        commit_command_suggestion: 'git commit -m "feat(workflow): final report"',
        commit_question: 'Do you want me to commit now? (yes/no)'
    };

    return {
        ...base,
        ...overrides,
        artifact_paths: {
            ...base.artifact_paths,
            ...(overrides.artifact_paths || {})
        },
        implementation_summary: {
            ...base.implementation_summary,
            ...(overrides.implementation_summary || {})
        },
        review_integrity_attestation: overrides.review_integrity_attestation
            ? { ...base.review_integrity_attestation!, ...overrides.review_integrity_attestation }
            : base.review_integrity_attestation,
        workflow: overrides.workflow === undefined ? base.workflow : overrides.workflow,
        docs: {
            ...base.docs,
            ...(overrides.docs || {})
        }
    };
}

describe('gates/task-audit-summary final user report rendering', () => {
    it('renders no-review-required final user reports without review timing warnings', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            implementation_summary: {
                review_verdicts: {},
                docs_updated: false,
                changed_files_count: 1,
                changed_lines_total: 3,
                scope_category: 'docs',
                active_profile: 'balanced'
            },
            review_timing_audit: {
                entries: [],
                visible_summary_line: 'Review timing audit: no required reviews.'
            },
            review_integrity_attestation: {
                status: 'NO_REVIEW_REQUIRED',
                required_review_count: 0,
                required_review_types: [],
                independent_review_completed: false,
                completion_review_attested: false,
                completion_review_attestation_not_required: true,
                completion_allowed: true,
                reason: 'No mandatory reviews were required for this scope.'
            }
        }));

        assert.ok(renderedReport.includes('Reviews:\nnone required'));
        assert.equal(renderedReport.includes('Process warnings:'), false);
    });

    it('renders BLOCKED status when final closeout is not ready', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            audit_status: 'BLOCKED',
            status: 'NOT_READY',
            blocker: 'completion gate has not passed'
        }));

        assert.ok(renderedReport.includes('Status: BLOCKED'));
        assert.ok(!renderedReport.includes('Status: READY'));
    });

    it('renders all actual review attempt durations and ignores reused materialization timings', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            implementation_summary: {
                review_verdicts: { code: 'REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                docs_updated: false,
                changed_files_count: 2,
                changed_lines_total: 14,
                scope_category: 'mixed',
                active_profile: 'balanced'
            },
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('code', 65_000),
                    makeFinalUserReportTimingEntry('code', 70_000),
                    makeFinalUserReportTimingEntry('test', 42_000),
                    makeFinalUserReportTimingEntry('test', 8_000, {
                        reused_existing_review: true,
                        hidden_timing_status: 'TRUSTED',
                        hidden_timing_distrust_code: null
                    })
                ],
                visible_summary_line: 'Review timing audit: code(TRUSTED); test(TRUSTED).'
            }
        }));

        assert.ok(renderedReport.includes('code(2): passed (1m 05s / 1m 10s)'));
        assert.ok(renderedReport.includes('test(1): passed (0m 42s)'));
        assert.ok(!renderedReport.includes('0m 08s'));
    });

    it('keeps unknown review durations in their original attempt positions', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('code', null, {
                        review_result_recorded_at_utc: '2026-01-01T00:00:01.000Z'
                    }),
                    makeFinalUserReportTimingEntry('code', 70_000, {
                        review_result_recorded_at_utc: '2026-01-01T00:00:02.000Z'
                    })
                ],
                visible_summary_line: 'Review timing audit: code(TRUSTED).'
            }
        }));

        assert.ok(renderedReport.includes('code(2): passed (unknown / 1m 10s)'));
    });

    it('uses authenticated attempt counts without inventing timing evidence', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [],
                visible_summary_line: 'Review timing audit: code(TRUSTED).'
            },
            review_attempt_summary: {
                total_attempts: 2,
                review_types: [{
                    review_type: 'code',
                    total_attempts: 2,
                    pass_count: 1,
                    fail_count: 1,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }],
                source_mode: 'task_events',
                visible_summary_line: 'Review attempts: total=2.'
            }
        }));

        assert.ok(renderedReport.includes('code(2): passed (unknown x2)'));
    });

    it('summarizes large missing-duration counts without proportional report growth', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [],
                visible_summary_line: 'Review timing audit: code(TRUSTED).'
            },
            review_attempt_summary: {
                total_attempts: 1_000_000,
                review_types: [{
                    review_type: 'code',
                    total_attempts: 1_000_000,
                    pass_count: 1,
                    fail_count: 999_999,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }],
                source_mode: 'task_events',
                visible_summary_line: 'Review attempts: total=1000000.'
            }
        }));

        assert.ok(renderedReport.includes('code(1000000): passed (unknown x1000000)'));
        assert.ok(renderedReport.length < 2_000);
    });

    it('does not let timing audit entries inflate authenticated attempt counts', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('code', 65_000),
                    makeFinalUserReportTimingEntry('code', 70_000)
                ],
                visible_summary_line: 'Review timing audit: code(TRUSTED).'
            },
            review_attempt_summary: {
                total_attempts: 1,
                review_types: [{
                    review_type: 'code',
                    total_attempts: 1,
                    pass_count: 1,
                    fail_count: 0,
                    reused_count: 0,
                    missing_or_invalid_count: 0
                }],
                source_mode: 'task_events',
                visible_summary_line: 'Review attempts: total=1.'
            }
        }));

        assert.ok(renderedReport.includes('code(1): passed (1m 05s)'));
        assert.ok(!renderedReport.includes('1m 10s'));
    });

    it('renders zero attempts when neither attempt nor timing evidence exists', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [],
                visible_summary_line: 'Review timing audit: code(TRUSTED).'
            },
            review_attempt_summary: {
                total_attempts: 0,
                review_types: [],
                source_mode: 'none',
                visible_summary_line: null
            }
        }));

        assert.ok(renderedReport.includes('code(0): passed'));
        assert.ok(!renderedReport.includes('code(1):'));
    });

    it('warns only for genuine timing distrust in mixed fresh and reused closeout entries', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('code', 65_000),
                    makeFinalUserReportTimingEntry('security', 40_000, {
                        reused_existing_review: true,
                        hidden_timing_status: 'TRUSTED',
                        hidden_timing_distrust_code: null
                    }),
                    makeFinalUserReportTimingEntry('performance', 5_000, {
                        hidden_timing_status: 'DISTRUSTED',
                        hidden_timing_distrust_code: 'too_short_without_strong_provider_evidence'
                    })
                ],
                visible_summary_line: 'Review timing audit: code(TRUSTED); security(TRUSTED); performance(DISTRUSTED).'
            }
        }));

        assert.ok(renderedReport.includes('WARNING: review accepted, but timing looked unusual'));
    });

    it('does not warn when only reused evidence has timing distrust', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('security', 40_000, {
                        reused_existing_review: true,
                        hidden_timing_status: 'DISTRUSTED',
                        hidden_timing_distrust_code: 'missing_timing'
                    })
                ],
                visible_summary_line: 'Review timing audit: security(DISTRUSTED:missing_timing).'
            }
        }));

        assert.ok(!renderedReport.includes('WARNING: review accepted, but timing looked unusual'));
    });

    it('renders delegated reviewer wall-clock duration instead of gate finalization seconds', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            implementation_summary: {
                review_verdicts: { api: 'API REVIEW PASSED' },
                docs_updated: false,
                changed_files_count: 2,
                changed_lines_total: 20,
                scope_category: 'mixed',
                active_profile: 'strict'
            },
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('api', 125_000, {
                        gate_finalize_ms: 1_000,
                        launch_to_result_ms: 1_000,
                        launch_to_source_mtime_ms: 1_000
                    })
                ],
                visible_summary_line: 'Review timing audit: api(TRUSTED, delegation_to_result=125000ms, gate_finalize=1000ms).'
            }
        }));

        assert.ok(renderedReport.includes('api(1): passed (2m 05s)'));
        assert.ok(!renderedReport.includes('0m 01s'));
    });

    it('renders all fresh review timings after a failed-then-passed review lifecycle', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            implementation_summary: {
                review_verdicts: { test: 'TEST REVIEW PASSED' },
                docs_updated: false,
                changed_files_count: 3,
                changed_lines_total: 30,
                scope_category: 'mixed',
                active_profile: 'strict'
            },
            review_timing_audit: {
                entries: [
                    makeFinalUserReportTimingEntry('test', 50_000),
                    makeFinalUserReportTimingEntry('test', 125_000)
                ],
                visible_summary_line: 'Review timing audit: test(TRUSTED).'
            }
        }));

        assert.equal(renderedReport.includes('Profile:'), false);
        assert.ok(renderedReport.includes('test(2): passed (0m 50s / 2m 05s)'));
        assert.equal(renderedReport.includes('Process warnings:'), false);
    });

    it('renders full-suite timeout warning evidence in the final user report', () => {
        const renderedReport = formatFinalUserReport(makeFinalUserReportCloseout({
            workflow: {
                mandatory_full_suite_enabled: true,
                visible_summary_line: 'Mandatory full-suite: true',
                full_suite_timeout: {
                    artifact_present: true,
                    status: 'WARNED',
                    timed_out: true,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    max_attempts: 1,
                    attempts_count: 1,
                    attempts_exhausted: true,
                    warning_only_continuation: true,
                    repair_task_proposal: null,
                    warnings: [
                        'Full suite validation timed out, but timeout_blocker=false.'
                    ],
                    forecast_warning: 'Duration history was unreadable; using configured timeout fallback.',
                    forecast_excluded_sample_count: 2,
                    forecast_excluded_sample_reasons: {
                        timed_out: 1,
                        retry_contaminated: 1
                    },
                    visible_summary_line: 'Full-suite timeout: status=WARNED; timed_out=true; blocker=false; retry_count=0; attempts=1/1; exhausted=true; warning_only=true; forecast_excluded=2 (retry_contaminated=1, timed_out=1); warnings=2'
                }
            }
        }));

        assert.ok(renderedReport.includes('Full suite: warned'));
        assert.ok(renderedReport.includes('Process warnings:'));
        assert.ok(renderedReport.includes('status=WARNED; timed\\_out=true; blocker=false'));
        assert.ok(renderedReport.includes('Warning: Full suite validation timed out, but timeout\\_blocker=false.'));
        assert.ok(renderedReport.includes('Forecast warning: Duration history was unreadable; using configured timeout fallback.'));

        const structuralWarningReport = formatFinalUserReport(makeFinalUserReportCloseout({
            workflow: {
                mandatory_full_suite_enabled: true,
                visible_summary_line: 'Mandatory full-suite: true',
                full_suite_timeout: {
                    artifact_present: true,
                    status: 'WARNED',
                    timed_out: true,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    max_attempts: 1,
                    attempts_count: 1,
                    attempts_exhausted: true,
                    warning_only_continuation: true,
                    repair_task_proposal: null,
                    warnings: [],
                    forecast_warning: null,
                    forecast_excluded_sample_count: 0,
                    forecast_excluded_sample_reasons: {},
                    visible_summary_line: '- Spoof process warning'
                }
            }
        }));
        assert.ok(structuralWarningReport.includes('Process warnings:\n\\- Spoof process warning'));
    });

    it('bounds full-suite warning count and individual warning length without mutating machine evidence', () => {
        const warnings = [
            `oversized-${'x'.repeat(5_000)}`,
            ...Array.from({ length: 20 }, (_, index) => `warning-${index + 1}`)
        ];
        const closeout = makeFinalUserReportCloseout({
            workflow: {
                mandatory_full_suite_enabled: true,
                visible_summary_line: 'Mandatory full-suite: true',
                full_suite_timeout: {
                    artifact_present: true,
                    status: 'WARNED',
                    timed_out: true,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    max_attempts: 1,
                    attempts_count: 1,
                    attempts_exhausted: true,
                    warning_only_continuation: true,
                    repair_task_proposal: null,
                    warnings,
                    forecast_warning: null,
                    forecast_excluded_sample_count: 0,
                    forecast_excluded_sample_reasons: {},
                    visible_summary_line: 'Full-suite timeout warning summary'
                }
            }
        });

        const renderedReport = formatFinalUserReport(closeout);

        assert.ok(renderedReport.includes('4019 more character(s); see machine-readable closeout evidence.'));
        assert.ok(renderedReport.includes('12 more process warning(s); see machine-readable closeout evidence.'));
        assert.ok(renderedReport.length < 5_000);
        const timeoutEvidence = closeout.workflow?.full_suite_timeout;
        assert.ok(timeoutEvidence);
        assert.equal(timeoutEvidence.warnings.length, 21);
        assert.equal(timeoutEvidence.warnings[0], warnings[0]);
        assert.equal(timeoutEvidence.warnings[20], 'warning-20');
    });

    it('bounds and neutralizes noncanonical review labels and verdicts before composing review lines', () => {
        const reviewType = `unsafe\n## review <type> [label](https://example.invalid)${'t'.repeat(5_000)}`;
        const verdict = `UNKNOWN\nUnresolved blockers: <script> ![pixel](https://example.invalid)${'v'.repeat(5_000)}`;
        const closeout = makeFinalUserReportCloseout({
            implementation_summary: {
                review_verdicts: { [reviewType]: verdict },
                docs_updated: false,
                changed_files_count: 1,
                changed_lines_total: 1,
                scope_category: 'code',
                active_profile: 'strict'
            },
            review_timing_audit: {
                entries: [],
                visible_summary_line: 'Review timing audit: no authenticated durations.'
            }
        });

        const renderedReport = formatFinalUserReport(closeout);

        assert.equal(renderedReport.includes('\n## review'), false);
        assert.equal(renderedReport.includes('<type>'), false);
        assert.equal(renderedReport.includes('<script>'), false);
        assert.ok(renderedReport.includes('unsafe ## review &lt;type&gt;'));
        assert.equal(renderedReport.includes('[label](https://example.invalid)'), false);
        assert.equal(renderedReport.includes('![pixel](https://example.invalid)'), false);
        assert.ok(renderedReport.includes('\\[label\\](https\\://example.invalid)'));
        assert.ok(renderedReport.includes('\\!\\[pixel\\](https\\://example.invalid)'));
        assert.ok(renderedReport.includes('more character(s); see machine-readable closeout evidence.'));
        assert.ok(renderedReport.length < 2_500);
        assert.equal(closeout.implementation_summary.review_verdicts[reviewType], verdict);
    });
});
