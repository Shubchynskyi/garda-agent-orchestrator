import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { runCompletionGate } from '../../../src/gates/completion';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from '../cli/commands/gate-test-helpers';

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function writeStrictCompletionWorkflowConfig(repoRoot: string): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
}

function writePassedReviewGate(repoRoot: string, taskId: string, preflightPath: string, reviewType: 'code' | 'test', verdict: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const preflightHash = fileSha256(preflightPath);
    writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: preflightHash,
        required_reviews: { [reviewType]: true },
        verdicts: { [reviewType]: verdict },
        review_checks: {
            [reviewType]: {
                required: true,
                skipped_by_override: false,
                verdict,
                pass_token: verdict,
                receipt_valid: true,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: `agent:${reviewType}-reviewer`,
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED'
            }
        }
    });
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
        preflight_hash_sha256: preflightHash,
        required_reviews: { [reviewType]: true }
    });
}

function writeNoDocImpact(repoRoot: string, taskId: string, rationale: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        decision: 'NO_DOC_UPDATES',
        rationale
    });
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
        decision: 'NO_DOC_UPDATES'
    });
}

function runDeferredFollowupIntegrationScenario(options: {
    taskId: string;
    taskSummary: string;
    scopeCategory: 'code' | 'test-only';
    reviewType: 'code' | 'test';
    verdict: 'REVIEW PASSED' | 'TEST REVIEW PASSED';
    deferredFinding: string;
    reviewBody: string;
    followupTitle: string;
    followupArea: string;
    followupRationale: string;
}): void {
    const repoRoot = createTempRepo();
    try {
        seedTaskQueue(repoRoot, options.taskId, 'IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writeStrictCompletionWorkflowConfig(repoRoot);
        const preflightPath = writePreflight(repoRoot, options.taskId, {
            scope_category: options.scopeCategory,
            required_reviews: {
                code: options.reviewType === 'code',
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: options.reviewType === 'test',
                performance: false,
                infra: false,
                dependency: false
            },
            profile_selection: {
                task_profile: 'strict',
                effective_profile: 'strict'
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId: options.taskId,
            taskSummary: options.taskSummary,
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, options.taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, options.taskId);
        runShellSmokeForTask(repoRoot, options.taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, options.taskId, preflightPath).exitCode, 0);
        appendTaskEvent(getOrchestratorRoot(repoRoot), options.taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
            preflight_path: preflightPath.replace(/\\/g, '/')
        });
        writeCompilePassEvidence(repoRoot, options.taskId, preflightPath);
        writeReceiptBackedReviewArtifact(repoRoot, options.taskId, options.reviewType, options.verdict, [
            options.reviewType === 'test' ? '# Test Review' : '# Review',
            '',
            options.reviewBody,
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            `- ${options.deferredFinding}`,
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            options.verdict
        ]);
        writePassedReviewGate(repoRoot, options.taskId, preflightPath, options.reviewType, options.verdict);
        writeNoDocImpact(repoRoot, options.taskId, options.followupRationale);

        const missing = runCompletionGate({ repoRoot, preflightPath, taskId: options.taskId });
        assert.equal(missing.status, 'FAILED');
        assert.equal(missing.deferred_followup_evidence.status, 'FAILED');
        assert.equal(missing.deferred_followup_evidence.checked_count, 1);
        assert.ok(missing.violations.some((violation: string) => violation.includes('must be materialized as a separate TASK.md follow-up')));
        assert.ok(missing.violations.some((violation: string) => violation.includes(`Suggested follow-up task id: ${options.taskId}-F1`)));

        fs.appendFileSync(
            path.join(repoRoot, 'TASK.md'),
            [
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| ${options.taskId}-F1 | TODO | P2 | ${options.followupArea} | ${options.followupTitle} | unassigned | 2026-03-28 | balanced | Deferred from ${options.taskId} ${options.reviewType} review artifact ${options.taskId}-${options.reviewType}.md. Original finding: ${options.deferredFinding} |`
            ].join('\n'),
            'utf8'
        );

        const passed = runCompletionGate({ repoRoot, preflightPath, taskId: options.taskId });
        assert.equal(passed.status, 'PASSED', JSON.stringify(passed, null, 2));
        assert.equal(passed.deferred_followup_evidence.status, 'PASS');
        assert.equal(passed.deferred_followup_evidence.matched_count, 1);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

describe('gates/completion — deferred follow-up integration', () => {
    it('blocks strict completion until deferred code-review findings have TASK.md follow-up rows', () => {
        runDeferredFollowupIntegrationScenario({
            taskId: 'T-904c-strict-deferred-followups',
            taskSummary: 'Validate strict deferred follow-up completion gate',
            scopeCategory: 'code',
            reviewType: 'code',
            verdict: 'REVIEW PASSED',
            deferredFinding: 'Add integration coverage for completion-gate deferred follow-up enforcement. Justification: Proves runCompletionGate blocks strict closeout until accepted follow-up work is tracked.',
            reviewBody: 'Verified `src/gates/completion.ts` strict deferred follow-up handling through the completion gate path with a realistic review artifact, receipt-backed trust evidence, and lifecycle gate state.',
            followupTitle: 'Add deferred follow-up regression',
            followupArea: 'tests',
            followupRationale: 'Focused strict deferred follow-up completion regression.'
        });
    });

    it('blocks strict completion until deferred specialized-review findings have TASK.md follow-up rows', () => {
        runDeferredFollowupIntegrationScenario({
            taskId: 'T-904d-strict-specialized-deferred',
            taskSummary: 'Validate strict deferred follow-up completion gate for test review',
            scopeCategory: 'test-only',
            reviewType: 'test',
            verdict: 'TEST REVIEW PASSED',
            deferredFinding: 'Add specialized review-type regression coverage. Justification: Hardening for future specialized policy changes.',
            reviewBody: 'Verified strict deferred follow-up handling for specialized review types. This text must be reasonably long to avoid being flagged as trivial or obviously synthetic by the completion gate filter which requires over 100 characters of substantive review material.',
            followupTitle: 'Add specialized review-type follow-up regression',
            followupArea: 'test',
            followupRationale: 'Focused strict deferred follow-up completion regression for specialized reviews.'
        });
    });
});
