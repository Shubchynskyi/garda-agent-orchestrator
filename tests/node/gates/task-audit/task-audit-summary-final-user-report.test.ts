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

        assert.ok(renderedReport.includes('Review Verdicts:\nnone required'));
        assert.match(renderedReport.trimEnd(), /Review Timing Warning:\nnone\n\nKnown Non-Blocking Signals:\nnone$/u);
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
                        hidden_timing_status: 'SKIPPED_REUSED',
                        hidden_timing_distrust_code: null
                    })
                ],
                visible_summary_line: 'Review timing audit: code(TRUSTED); test(SKIPPED_REUSED).'
            }
        }));

        assert.ok(renderedReport.includes('code(2): passed (1m 05s / 1m 10s)'));
        assert.ok(renderedReport.includes('test(1): passed (0m 42s)'));
        assert.ok(!renderedReport.includes('0m 08s'));
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

        assert.ok(renderedReport.includes('Profile: strict'));
        assert.ok(renderedReport.includes('test(2): passed (0m 50s / 2m 05s)'));
        assert.match(renderedReport.trimEnd(), /Review Timing Warning:\nnone\n\nKnown Non-Blocking Signals:\nnone$/u);
    });
});
