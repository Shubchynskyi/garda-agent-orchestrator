import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { runCompletionGate } from '../../../../src/gates/completion';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    assessProjectMemoryImpact
} from '../../../../src/gates/project-memory-impact';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
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
} from '../../cli/commands/gate-test-helpers';

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function writeProjectMemoryWorkflowConfig(repoRoot: string, enabled = true): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = enabled;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
}

function seedProjectMemory(repoRoot: string): void {
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nConfirmed project memory content.\n`, 'utf8');
    }
}

function recordCurrentProjectMemoryImpact(repoRoot: string, taskId: string, preflightPath: string): void {
    const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
    writeJson(result.artifactPath, result.artifact);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
        'PASS',
        'Project memory impact gate assessed memory impact.',
        result.artifact
    );
}

describe('gates/completion review trust', () => {
    it('does not fall back to receipt-derived independent trust when current review gate is incomplete', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-completion-trust-gate';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot, false);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate completion review trust fallback',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                rationale: 'Focused completion trust regression.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES'
            });

            const result = runCompletionGate({
                repoRoot,
                preflightPath,
                taskId
            });

            assert.equal(result.status, 'PASSED', JSON.stringify(result, null, 2));
            assert.equal(result.review_artifacts?.code?.receipt?.trust_level, 'INDEPENDENT_AUDITED');
            assert.equal(result.review_trust_summary?.status, 'UNAVAILABLE');
            assert.match(result.review_trust_summary?.visible_summary_line || '', /incomplete or invalid/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('requires current project memory impact evidence before completion when maintenance is enabled', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-completion';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory completion gate',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                rationale: 'Focused project memory completion regression.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES'
            });

            const missing = runCompletionGate({ repoRoot, preflightPath, taskId });
            assert.equal(missing.status, 'FAILED');
            assert.equal(missing.project_memory_impact_evidence.evidence_status, 'MISSING');
            assert.ok(missing.violations.some((violation: string) => violation.includes('Project memory impact evidence')));

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const passed = runCompletionGate({ repoRoot, preflightPath, taskId });
            assert.equal(passed.status, 'PASSED', JSON.stringify(passed, null, 2));
            assert.equal(passed.project_memory_impact_evidence.evidence_status, 'CURRENT');
            assert.equal(passed.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects doc-impact project_memory_updated claims when project-memory-impact records no update', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-claim-mismatch';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory claim parity',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_updated: true,
                rationale: 'Internal behavior evidence claims project memory was updated.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_updated: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
            assert.ok(result.violations.some((violation: string) => violation.includes('project_memory_updated=true')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts doc-impact project_memory_update_not_needed claims when project-memory-impact records no update', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-no-update-needed';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['tests/node/gates/doc-impact/doc-impact.test.ts'],
                scope_category: 'test',
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: true,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory no-update-needed parity',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'REVIEW PASSED');

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true },
                verdicts: { test: 'REVIEW PASSED' },
                review_checks: {
                    test: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:test-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { test: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_update_not_needed: true,
                rationale: 'Internal behavior was checked against project memory and no update was needed.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_update_not_needed: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'PASSED', JSON.stringify(result, null, 2));
            assert.equal(result.project_memory_impact_evidence.status, 'NO_UPDATE_NEEDED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects doc-impact project_memory_update_not_needed claims when project-memory-impact records update-needed evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c-project-memory-no-update-mismatch';

        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Codex');
            writeProjectMemoryWorkflowConfig(repoRoot);
            seedProjectMemory(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/gates/project-memory-impact.ts'],
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Validate project memory no-update-needed mismatch',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'Implementation started.', {
                preflight_path: preflightPath.replace(/\\/g, '/')
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

            const reviewsRoot = getReviewsRoot(repoRoot);
            const preflightHash = fileSha256(preflightPath);
            writeJson(path.join(reviewsRoot, `${taskId}-review-gate.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true },
                verdicts: { code: 'REVIEW PASSED' },
                review_checks: {
                    code: {
                        required: true,
                        skipped_by_override: false,
                        verdict: 'REVIEW PASSED',
                        pass_token: 'REVIEW PASSED',
                        receipt_valid: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    }
                }
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Review gate passed.', {
                preflight_hash_sha256: preflightHash,
                required_reviews: { code: true }
            });

            writeJson(path.join(reviewsRoot, `${taskId}-doc-impact.json`), {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES',
                behavior_changed: true,
                project_memory_update_not_needed: true,
                rationale: 'Internal behavior claims project memory did not need updates.'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'DOC_IMPACT_ASSESSED', 'PASS', 'Doc impact assessed.', {
                decision: 'NO_DOC_UPDATES',
                project_memory_update_not_needed: true
            });

            recordCurrentProjectMemoryImpact(repoRoot, taskId, preflightPath);
            const result = runCompletionGate({ repoRoot, preflightPath, taskId });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((violation: string) => violation.includes('project_memory_update_not_needed=true')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

});
