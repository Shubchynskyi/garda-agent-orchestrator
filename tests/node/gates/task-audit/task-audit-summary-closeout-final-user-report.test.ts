import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';

import {
    fs,
    path,
    spawn,
    createHash,
    execFileSync,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    ensureSkillsHeadlinesCurrent,
    getWorkspaceSnapshot,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    NODE_BACKEND_SKILL_SOURCE,
    computeFileSha256,
    computeTaskTextSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writePassedLifecycleWithReviewRecorded,
    writeWorkflowConfig,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    writeProjectMemoryImpactArtifact,
    writePathsConfig,
    writePassedLifecycle,
    makeIndependentReviewGateCheck,
    makeReviewerInvocationProvenance,
    makeDelegatedRouting,
    writeRequiredCodeScenario,
    buildCurrentTaskAuditSummary,
    assertReviewIntegrity,
    assertReviewIntegrityBlocksFinalCloseout,
    writeCurrentIndependentReviewFixture,
    initGitRepo,
    writeActiveCompletionLock,
    makeTempDir,
    type TaskAuditSummaryResult
} from './task-audit-summary-fixtures';


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
            const renderedReport = formatFinalUserReport({
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
            });

            assert.ok(renderedReport.includes('Status: DONE'));
            assert.ok(renderedReport.includes('MandatoryFullSuite: disabled'));
            assert.ok(renderedReport.includes('db(1): passed (0m 11s)'));
            assert.ok(renderedReport.includes('test(1): passed (1m 16s)'));
            assert.ok(!renderedReport.includes('PathMode:'));
            assert.ok(!renderedReport.includes('Commit Readiness:'));
            assert.ok(!renderedReport.includes('Operator Question:'));
            assert.match(
                renderedReport.trimEnd(),
                /Review Timing Warning:\nWARNING: suspicious or insufficiently verified review timing\/evidence detected for db\(too_short_without_strong_provider_evidence\)\..*\n\nAdvisory Notes:\nnone$/u
            );
        });

    });
});
