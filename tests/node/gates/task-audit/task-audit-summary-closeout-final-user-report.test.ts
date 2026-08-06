import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';

import {
    fs,
    path,
    writeWorkflowConfig,
    makeTempDir} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {

        it('renders concise final user report with inline review durations and warning last', () => {
            const closeout: Parameters<typeof formatFinalUserReport>[0] = {
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md',
                    final_user_report: 'runtime/reviews/T-149-final-user-report.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { db: 'DB REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 12,
                    scope_category: 'mixed',
                    active_profile: 'balanced'
                },
                review_timing_audit: {
                    entries: [
                        {
                            review_type: 'db',
                            reviewer_identity: 'agent:db-reviewer',
                            reviewer_execution_mode: 'delegated_subagent',
                            reused_existing_review: false,
                            receipt_path: 'runtime/reviews/T-149-db-receipt.json',
                            receipt_sha256: null,
                            review_output_path: null,
                            review_output_sha256: null,
                            provider: 'Antigravity',
                            provider_invocation_id: 'agent:t149-db-reviewer',
                            reviewer_launch_attestation_source: 'provider_subagent',
                            launch_prepared_at_utc: null,
                            delegation_started_at_utc: null,
                            launched_at_utc: null,
                            launch_completed_at_utc: null,
                            invocation_attested_at_utc: null,
                            review_result_recorded_at_utc: null,
                            review_output_source_mtime_utc: null,
                            delegation_to_result_ms: 11_840,
                            delegation_to_source_mtime_ms: null,
                            gate_finalize_ms: null,
                            launch_to_result_ms: 11_840,
                            launch_to_source_mtime_ms: null,
                            hidden_timing_status: 'DISTRUSTED',
                            hidden_timing_distrust_code: 'too_short_without_strong_provider_evidence'
                        },
                        {
                            review_type: 'test',
                            reviewer_identity: 'agent:test-reviewer',
                            reviewer_execution_mode: 'delegated_subagent',
                            reused_existing_review: false,
                            receipt_path: 'runtime/reviews/T-149-test-receipt.json',
                            receipt_sha256: null,
                            review_output_path: null,
                            review_output_sha256: null,
                            provider: 'Codex',
                            provider_invocation_id: 'codex-run-1',
                            reviewer_launch_attestation_source: 'codex.spawn_agent',
                            launch_prepared_at_utc: null,
                            delegation_started_at_utc: null,
                            launched_at_utc: null,
                            launch_completed_at_utc: null,
                            invocation_attested_at_utc: null,
                            review_result_recorded_at_utc: null,
                            review_output_source_mtime_utc: null,
                            delegation_to_result_ms: 76_522,
                            delegation_to_source_mtime_ms: null,
                            gate_finalize_ms: null,
                            launch_to_result_ms: 76_522,
                            launch_to_source_mtime_ms: null,
                            hidden_timing_status: 'TRUSTED',
                            hidden_timing_distrust_code: null
                        }
                    ],
                    visible_summary_line: 'Review timing audit: db(DISTRUSTED); test(TRUSTED).'
                },
                review_integrity_attestation: {
                    schema_version: 1,
                    enforcement_mode: 'BLOCKING',
                    status: 'INDEPENDENT_REVIEW_ATTESTED',
                    required_review_count: 2,
                    required_review_types: ['db', 'test'],
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
                review_findings_audit: {
                    status: 'CLEAR',
                    lanes: [{
                        review_type: 'test',
                        source_mode: 'fresh',
                        validation_status: 'ACCEPTED',
                        validation_violations: [],
                        disposition_status: 'SATISFIED',
                        disposition_counts: { fix_now: 0, create_follow_up: 1, ignore: 0 },
                        disposition_violations: [],
                        findings: [{
                            id: 'F-001',
                            kind: 'finding',
                            severity: 'medium',
                            title: 'Detailed finding title that must stay out of chat',
                            description: 'Detailed finding description that must stay in the audit artifact.',
                            evidence_locations: ['src/example.ts:10'],
                            coverage_obligation_ids: ['FILE-001'],
                            action: 'create_follow_up',
                            materialization_status: 'MATERIALIZED',
                            follow_up_task_id: 'T-AUDIT-1-F1',
                            blocking: false
                        }],
                        remaining_blocker_ids: []
                    }],
                    finding_count: 1,
                    residual_risk_count: 0,
                    disposition_counts: { fix_now: 0, create_follow_up: 1, ignore: 0 },
                    remaining_blocker_count: 0,
                    validation_failures: [{
                        timestamp_utc: '2026-01-01T00:00:00.000Z',
                        review_type: 'test',
                        reviewer_identity: 'agent:test-reviewer',
                        violation: 'Verbose historical validation detail that must stay out of chat.',
                        validation_artifact_sha256: null
                    }],
                    remediation_cycles: [],
                    fresh_review_count: 1,
                    reused_review_count: 0,
                    visible_summary_line: 'Verbose legacy summary that must stay out of chat.'
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
            const renderedReport = formatFinalUserReport(closeout);

            assert.ok(renderedReport.includes('Status: DONE'));
            assert.ok(renderedReport.includes('MandatoryFullSuite: disabled'));
            assert.ok(renderedReport.includes('db(1): findings-satisfied (0m 11s)'));
            assert.ok(renderedReport.includes('test(1): findings-satisfied (1m 16s)'));
            assert.ok(!renderedReport.includes('PathMode:'));
            assert.ok(!renderedReport.includes('Commit Readiness:'));
            assert.ok(!renderedReport.includes('Operator Question:'));
            assert.ok(renderedReport.includes('Summary: status=CLEAR; findings=1; residual_risks=0; fix_now=0; follow_up=1; ignored=0; remaining_blockers=0'));
            assert.ok(renderedReport.includes('FollowUpTasksCreated: T-AUDIT-1-F1'));
            assert.ok(renderedReport.includes('ReviewDiagnostics: validation_failures=1; remediation_cycles=0'));
            assert.ok(renderedReport.includes('AuditDetails: runtime/reviews/T-149-final-closeout.json'));
            assert.equal(renderedReport.includes('Detailed finding title that must stay out of chat'), false);
            assert.equal(renderedReport.includes('Verbose historical validation detail that must stay out of chat'), false);
            assert.match(
                renderedReport.trimEnd(),
                /Review Timing Warning:\nWARNING: review accepted, but timing looked unusual; operator may double-check\.\n\nAdvisory Notes:\nnone$/u
            );

            const noFindingsReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    status: 'CLEAR',
                    lanes: [],
                    finding_count: 0,
                    residual_risk_count: 0,
                    disposition_counts: { fix_now: 0, create_follow_up: 0, ignore: 0 },
                    remaining_blocker_count: 0,
                    validation_failures: [],
                    remediation_cycles: [],
                    fresh_review_count: 0,
                    reused_review_count: 0,
                    visible_summary_line: 'Review findings audit: status=CLEAR; findings=0.'
                }
            });
            assert.ok(noFindingsReport.includes('Summary: status=CLEAR; findings=0; residual_risks=0; fix_now=0; follow_up=0; ignored=0; remaining_blockers=0'));
            assert.ok(noFindingsReport.includes('FollowUpTasksCreated: none'));
            assert.equal(noFindingsReport.includes('ReviewDiagnostics:'), false);

            const incompleteDispositionReport = formatFinalUserReport({
                ...closeout,
                review_findings_audit: {
                    status: 'BLOCKED',
                    lanes: [{
                        review_type: 'test',
                        source_mode: 'fresh',
                        validation_status: 'ACCEPTED',
                        validation_violations: [],
                        disposition_status: 'BLOCKED',
                        disposition_counts: { fix_now: 1, create_follow_up: 1, ignore: 0 },
                        disposition_violations: [],
                        findings: [{
                            id: 'F-BLOCKING',
                            kind: 'finding',
                            severity: 'high',
                            title: 'Blocking detail remains in the audit artifact.',
                            description: 'The compact report must still expose the finding id.',
                            evidence_locations: ['src/example.ts:20'],
                            coverage_obligation_ids: ['FILE-002'],
                            action: 'fix_now',
                            materialization_status: 'NOT_REQUIRED',
                            follow_up_task_id: null,
                            blocking: true
                        }, {
                            id: 'F-UNMATERIALIZED',
                            kind: 'finding',
                            severity: 'medium',
                            title: 'Follow-up detail remains in the audit artifact.',
                            description: 'The compact report must expose missing task materialization.',
                            evidence_locations: ['src/example.ts:30'],
                            coverage_obligation_ids: ['FILE-003'],
                            action: 'create_follow_up',
                            materialization_status: 'PENDING',
                            follow_up_task_id: null,
                            blocking: false
                        }],
                        remaining_blocker_ids: ['F-BLOCKING']
                    }],
                    finding_count: 2,
                    residual_risk_count: 0,
                    disposition_counts: { fix_now: 1, create_follow_up: 1, ignore: 0 },
                    remaining_blocker_count: 1,
                    validation_failures: [],
                    remediation_cycles: [],
                    fresh_review_count: 1,
                    reused_review_count: 0,
                    visible_summary_line: 'Verbose blocked summary that must stay out of chat.'
                }
            });
            assert.ok(incompleteDispositionReport.includes('BlockingFindings: test/F-BLOCKING'));
            assert.ok(incompleteDispositionReport.includes('UnmaterializedFollowUps: test/F-UNMATERIALIZED'));
            assert.equal(incompleteDispositionReport.includes('Blocking detail remains in the audit artifact.'), false);
        });

    });
});
