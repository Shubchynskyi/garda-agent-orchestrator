import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCommitCommandSuggestion,
    formatTaskAuditSummaryText
} from '../../../../src/gates/task-audit/task-audit-summary-renderers';
import { formatProfileGuardrailDiagnostics } from '../../../../src/policy/profile-resolver';

describe('buildCommitCommandSuggestion', () => {
    it('returns human-commit command when commit guard is ON', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-123',
            status: 'IN_PROGRESS',
            priority: 'P1',
            area: 'core',
            title: 'Fix the thing',
            assignee: 'unassigned',
            updated: '2026-04-30',
            profile: 'default',
            notes: 'fixture',
            isPlaceholder: false
        };
        const result = buildCommitCommandSuggestion(changedFiles, metadata, true);
        assert.ok(result.template.includes('human-commit'), 'Template should use human-commit');
        assert.ok(result.suggestion.includes('human-commit'), 'Suggestion should use human-commit');
        assert.ok(result.template.includes('--operator-confirmed yes'), 'Template should require operator confirmation');
        assert.ok(result.suggestion.includes('--operator-confirmed yes'), 'Suggestion should require operator confirmation');
        assert.ok(!result.template.includes('git commit -m'), 'Template should not use bare git commit');
        assert.ok(!result.suggestion.includes('git commit -m'), 'Suggestion should not use bare git commit');
    });

    it('returns git commit command when commit guard is OFF', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-123',
            status: 'IN_PROGRESS',
            priority: 'P1',
            area: 'core',
            title: 'Fix the thing',
            assignee: 'unassigned',
            updated: '2026-04-30',
            profile: 'default',
            notes: 'fixture',
            isPlaceholder: false
        };
        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);
        assert.ok(!result.template.includes('human-commit'), 'Template should not use human-commit');
        assert.ok(!result.suggestion.includes('human-commit'), 'Suggestion should not use human-commit');
        assert.ok(result.template.includes('git commit -m'), 'Template should use bare git commit');
        assert.ok(result.suggestion.includes('git commit -m'), 'Suggestion should use bare git commit');
    });

    it('uses the task title instead of a one-word area suffix for informative suggestions', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-546',
            status: 'IN_PROGRESS',
            priority: 'P2',
            area: 'settings',
            title: 'Improve settings validation feedback',
            assignee: 'unassigned',
            updated: '2026-05-14',
            profile: 'balanced',
            notes: 'fixture',
            isPlaceholder: false
        };

        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);

        assert.equal(result.suggestion, 'git commit -m "fix(settings): improve settings validation feedback"');
        assert.ok(!result.suggestion.includes('feat(settings): settings'));
    });

    it('falls back to the template when both area and title would be tautological', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-547',
            status: 'IN_PROGRESS',
            priority: 'P2',
            area: 'settings',
            title: 'Settings',
            assignee: 'unassigned',
            updated: '2026-05-14',
            profile: 'balanced',
            notes: 'fixture',
            isPlaceholder: false
        };

        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);

        assert.equal(result.suggestion, 'git commit -m "<type>(<scope>): <summary>"');
    });
});

describe('profile review decision rendering', () => {
    it('renders preflight_required decisions as positive task-audit profile diagnostics', () => {
        const text = formatTaskAuditSummaryText({
            task_id: 'T-715',
            generated_utc: '2026-06-05T00:00:00.000Z',
            status: 'INCOMPLETE',
            events_count: 0,
            first_event_utc: null,
            last_event_utc: null,
            integrity_status: 'PASS',
            gates: [],
            changed_files: ['tests/example.test.ts'],
            changed_files_count: 1,
            changed_lines_total: 8,
            required_reviews: { refactor: true, test: true },
            scope_category: 'test-only',
            profile_review_decisions: {
                profile_name: 'strict',
                scope_category: 'test-only',
                guardrails_active: false,
                lightening_eligible: true,
                safety_floors_applied: [],
                decisions: [
                    { review_type: 'refactor', effective_value: true, decision: 'preflight_required' },
                    { review_type: 'test', effective_value: true, decision: 'capability_default' }
                ]
            },
            evidence: [],
            blockers: [],
            point_in_time_snapshot: { status: 'STABLE', gate: null, message: null, recommended_action: null, lock_path: null },
            final_report_contract: {
                status: 'NOT_READY',
                blocker: null,
                required_order: [],
                implementation_summary_requirements: [],
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "<type>(<scope>): <summary>"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            },
            final_closeout: {
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: 'T-715',
                generated_utc: '2026-06-05T00:00:00.000Z',
                status: 'INCOMPLETE',
                artifact_state: 'NOT_READY',
                artifact_paths: {
                    json: 'runtime/reviews/T-715-final-closeout.json',
                    markdown: 'runtime/reviews/T-715-final-closeout.md'
                },
                blockers: [],
                evidence: [],
                changed_files: ['tests/example.test.ts'],
                changed_files_count: 1,
                changed_lines_total: 8,
                required_reviews: { refactor: true, test: true },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: {},
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 8,
                    scope_category: 'test-only',
                    active_profile: 'strict'
                },
                optional_skills: null,
                docs: null,
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "<type>(<scope>): <summary>"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            }
        } as any);

        assert.ok(text.includes('RequiredReviews: refactor, test'));
        assert.ok(text.includes('ProfileReviewDecisions:'));
        assert.ok(text.includes('  [+] refactor: true (preflight_required)'));
        assert.ok(!text.includes('  [=] refactor: true (preflight_required)'));
    });

    it('renders preflight_required decisions as positive profile guardrail diagnostics', () => {
        const text = formatProfileGuardrailDiagnostics({
            scope_category: 'test-only',
            is_code_changing_task: false,
            profile_name: 'strict',
            guardrails_active: false,
            lightening_eligible: true,
            zero_diff_no_reviewable_scope: false,
            safety_floors_applied: [],
            decisions: [
                {
                    review_type: 'refactor',
                    profile_wanted: true,
                    effective_value: true,
                    decision: 'preflight_required',
                    reason: 'refactor review kept because preflight required_reviews.refactor=true'
                }
            ]
        });

        assert.ok(text.includes('  [+] refactor: true (preflight_required)'));
        assert.ok(!text.includes('  [=] refactor: true (preflight_required)'));
    });
});
