import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    formatTaskAuditSummaryText,
    writeWorkflowConfig,
    makeTempDir,
    type TaskAuditSummaryResult
} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
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

        it('renders compact text output', () => {
            const summary: TaskAuditSummaryResult = {
                task_id: 'T-TEST-1',
                generated_utc: '2026-01-01T00:00:00.000Z',
                status: 'INCOMPLETE',
                events_count: 3,
                first_event_utc: '2026-01-01T00:00:00.000Z',
                last_event_utc: '2026-01-01T00:01:00.000Z',
                integrity_status: 'PASS',
                gates: [
                    { gate: 'enter-task-mode', status: 'PASS', event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00.000Z' },
                    { gate: 'compile-gate', status: 'MISSING', event_type: 'COMPILE_GATE_PASSED' }
                ],
                changed_files: ['src/example.ts'],
                changed_files_count: 1,
                changed_lines_total: 50,
                required_reviews: { code: true, db: false },
                scope_category: null,
                profile_review_decisions: null,
                evidence: [
                    { kind: 'task-mode', path: 'runtime/reviews/T-TEST-1-task-mode.json', exists: true, sha256: 'abc123' },
                    { kind: 'preflight', path: 'runtime/reviews/T-TEST-1-preflight.json', exists: false, sha256: null }
                ],
                blockers: [
                    { gate: 'code-review', reason: 'Required code review artifact not found' }
                ],
                point_in_time_snapshot: {
                    status: 'FINALIZATION_IN_FLIGHT',
                    gate: 'completion-gate',
                    message: 'Completion gate is currently in flight, so this audit summary is a point-in-time snapshot and may still reflect an older completion result.',
                    recommended_action: 'Re-run task-audit-summary sequentially after completion-gate finishes.',
                    lock_path: 'runtime/reviews/T-TEST-1-completion-gate.lock'
                },
                final_report_contract: {
                    status: 'NOT_READY',
                    blocker: 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
                    required_order: [
                        'implementation summary',
                        'git commit -m "fix(orchestration): <summary>"',
                        'Do you want me to commit now? (yes/no)'
                    ],
                    implementation_summary_requirements: ['depth', 'path mode', 'review verdicts', 'docs updated'],
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                },
                final_closeout: {
                    schema_version: 1,
                    event_source: 'task-audit-summary',
                    task_id: 'T-TEST-1',
                    generated_utc: '2026-01-01T00:00:00.000Z',
                    audit_status: 'INCOMPLETE',
                    status: 'NOT_READY',
                    blocker: 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
                    artifact_state: 'NOT_READY',
                    artifact_paths: {
                        json: 'runtime/reviews/T-TEST-1-final-closeout.json',
                        markdown: 'runtime/reviews/T-TEST-1-final-closeout.md'
                    },
                    implementation_summary: {
                        requested_depth: 2,
                        effective_depth: 2,
                        path_mode: 'FULL_PATH',
                        review_verdicts: { code: 'MISSING' },
                        docs_updated: false,
                        changed_files_count: 1,
                        changed_lines_total: 50,
                        scope_category: null,
                        active_profile: null
                    },
                    optional_skills: {
                        policy_mode: 'advisory',
                        decision: 'as_is',
                        selected_skill_ids: [],
                        used_skill_ids: [],
                        recommended_missing_pack_ids: [],
                        as_is_reason: 'generic_context_sufficient',
                        visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                    },
                    docs: {
                        decision: 'NO_DOC_UPDATES',
                        behavior_changed: false,
                        changelog_updated: false,
                        docs_updated: []
                    },
                    token_economy: null,
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                }
            };

            const text = formatTaskAuditSummaryText(summary);

            assert.ok(text.includes('Task: T-TEST-1'));
            assert.ok(text.includes('Status: INCOMPLETE'));
            assert.ok(text.includes('Events: 3'));
            assert.ok(text.includes('[+] enter-task-mode'));
            assert.ok(text.includes('[ ] compile-gate'));
            assert.ok(text.includes('src/example.ts'));
            assert.ok(text.includes('RequiredReviews: code'));
            assert.ok(text.includes('[+] task-mode'));
            assert.ok(text.includes('[ ] preflight'));
            assert.ok(text.includes('Blockers:'));
            assert.ok(text.includes('code-review'));
            assert.ok(text.includes('PointInTimeSnapshot: FINALIZATION_IN_FLIGHT'));
            assert.ok(text.includes('RecommendedAction: Re-run task-audit-summary sequentially after completion-gate finishes.'));
            assert.ok(text.includes('FinalReportContract: NOT_READY'));
            assert.ok(text.includes('FinalCloseout: NOT_READY (NOT_READY)'));
            assert.ok(text.includes('Optional skills: as_is (reason: generic_context_sufficient)'));
            assert.ok(text.includes('git commit -m "fix(orchestration): <summary>"'));
        });

        it('omits blockers section when empty', () => {
            const summary: TaskAuditSummaryResult = {
                task_id: 'T-CLEAN',
                generated_utc: '2026-01-01T00:00:00.000Z',
                status: 'PASS',
                events_count: 0,
                first_event_utc: null,
                last_event_utc: null,
                integrity_status: 'PASS',
                gates: [],
                changed_files: [],
                changed_files_count: 0,
                changed_lines_total: 0,
                required_reviews: {},
                scope_category: null,
                profile_review_decisions: null,
                evidence: [],
                blockers: [],
                point_in_time_snapshot: {
                    status: 'STABLE',
                    gate: null,
                    message: null,
                    recommended_action: null,
                    lock_path: null
                },
                final_report_contract: {
                    status: 'READY',
                    blocker: null,
                    required_order: [
                        'implementation summary',
                        'git commit -m "fix(orchestration): <summary>"',
                        'Do you want me to commit now? (yes/no)'
                    ],
                    implementation_summary_requirements: ['depth', 'path mode', 'review verdicts', 'docs updated'],
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                },
                final_closeout: {
                    schema_version: 1,
                    event_source: 'task-audit-summary',
                    task_id: 'T-CLEAN',
                    generated_utc: '2026-01-01T00:00:00.000Z',
                    audit_status: 'PASS',
                    status: 'READY',
                    blocker: null,
                    artifact_state: 'MATERIALIZED',
                    artifact_paths: {
                        json: 'runtime/reviews/T-CLEAN-final-closeout.json',
                        markdown: 'runtime/reviews/T-CLEAN-final-closeout.md'
                    },
                    implementation_summary: {
                        requested_depth: 2,
                        effective_depth: 2,
                        path_mode: 'FULL_PATH',
                        review_verdicts: {},
                        docs_updated: false,
                        changed_files_count: 0,
                        changed_lines_total: 0,
                        scope_category: null,
                        active_profile: null
                    },
                    docs: {
                        decision: 'NO_DOC_UPDATES',
                        behavior_changed: false,
                        changelog_updated: false,
                        docs_updated: []
                    },
                    token_economy: null,
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                }
            };

            const text = formatTaskAuditSummaryText(summary);

            assert.ok(!text.includes('Blockers:'));
            assert.ok(text.includes('FinalReportContract: READY'));
            assert.ok(text.includes('FinalCloseout: READY (MATERIALIZED)'));
            assert.ok(text.includes('Do you want me to commit now? (yes/no)'));
        });

    });
});
