import { spawn, spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    type TaskAuditSummaryResult
} from '../../../../src/gates/task-audit/task-audit-summary';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import {
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate
} from '../../../../src/gates/task-audit/task-audit-summary-collectors';
import {
    inspectCompletionGateFinalizationLock,
    scanCompletionGateFinalizationLocks,
    withCompletionGateFinalizationLockAsync
} from '../../../../src/gates/locks/finalization-lock';
import { ensureSkillsHeadlinesCurrent } from '../../../../src/runtime/skill-headlines';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    assessProjectMemoryImpact
} from '../../../../src/gates/project-memory-impact';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { initGitRepo as initGitFixtureRepo } from '../git-fixtures';

export {
    spawn,
    spawnSync,
    execFileSync,
    fs,
    path,
    os,
    createHash,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    getWorkspaceSnapshot,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    inspectCompletionGateFinalizationLock,
    scanCompletionGateFinalizationLocks,
    withCompletionGateFinalizationLockAsync,
    ensureSkillsHeadlinesCurrent,
    buildEventIntegrityHash,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    assessProjectMemoryImpact,
    buildDefaultWorkflowConfig,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES
};
export type { TaskAuditSummaryResult };

export const NODE_BACKEND_SKILL_SOURCE = path.join(
    process.cwd(),
    'template',
    'skill-packs',
    'node-backend',
    'skills',
    'node-backend'
);

export function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'task-audit-test-'));
}

export function initGitRepo(repoRoot: string): void {
    initGitFixtureRepo(repoRoot, {
        allowEmptyCommit: true
    });
}

export function writeEvent(eventsDir: string, taskId: string, event: Record<string, unknown>): void {
    const file = path.join(eventsDir, `${taskId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
}

export function writePreflight(reviewsDir: string, taskId: string, data: Record<string, unknown>): void {
    const payload = {
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        ...data
    };
    if (Object.prototype.hasOwnProperty.call(data, 'review_execution_policy') && data.review_execution_policy === undefined) {
        delete (payload as Record<string, unknown>).review_execution_policy;
    }
    fs.writeFileSync(
        path.join(reviewsDir, `${taskId}-preflight.json`),
        JSON.stringify(payload),
        'utf8'
    );
}

export function writeArtifact(reviewsDir: string, taskId: string, suffix: string, data: unknown): void {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    fs.writeFileSync(path.join(reviewsDir, `${taskId}${suffix}`), content, 'utf8');
}

export function computeFileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function computeTaskTextSha256(taskText: string): string {
    return createHash('sha256').update(taskText.trim(), 'utf8').digest('hex');
}

export function writeIntegrityEventSequence(
    eventsDir: string,
    taskId: string,
    entries: Array<{ event_type: string; details?: unknown; timestamp_utc?: string }>
): Record<string, unknown>[] {
    const baseTime = Date.parse('2026-04-29T00:00:00.000Z');
    let previousEventSha256: string | null = null;
    return entries.map((entry, index) => {
        const event: Record<string, unknown> = {
            timestamp_utc: entry.timestamp_utc || new Date(baseTime + index * 1000).toISOString(),
            task_id: taskId,
            event_type: entry.event_type,
            outcome: 'PASS',
            actor: 'gate',
            message: `${entry.event_type} passed.`,
            details: entry.details || {}
        };
        event.integrity = { schema_version: 1, task_sequence: index + 1, prev_event_sha256: previousEventSha256 };
        const eventSha256 = buildEventIntegrityHash(event);
        if (!eventSha256) {
            throw new Error('Failed to build test event integrity hash.');
        }
        (event.integrity as Record<string, unknown>).event_sha256 = eventSha256;
        writeEvent(eventsDir, taskId, event);
        previousEventSha256 = eventSha256;
        return event;
    });
}

export function appendIntegrityEvent(eventsDir: string, taskId: string, entry: { event_type: string; details?: unknown; timestamp_utc?: string }): Record<string, unknown> {
    const lines = fs.readFileSync(path.join(eventsDir, `${taskId}.jsonl`), 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    const lastIntegrity = (JSON.parse(lines[lines.length - 1]) as Record<string, unknown>).integrity as Record<string, unknown>;
    const taskSequence = Number(lastIntegrity.task_sequence) + 1;
    const event: Record<string, unknown> = { timestamp_utc: entry.timestamp_utc || new Date(Date.parse('2026-04-29T00:00:00.000Z') + taskSequence * 1000).toISOString(), task_id: taskId, event_type: entry.event_type, outcome: 'PASS', actor: 'gate', message: `${entry.event_type} passed.`, details: entry.details || {} };
    event.integrity = { schema_version: 1, task_sequence: taskSequence, prev_event_sha256: lastIntegrity.event_sha256 };
    const eventSha256 = buildEventIntegrityHash(event);
    if (!eventSha256) { throw new Error('Failed to build test event integrity hash.'); }
    (event.integrity as Record<string, unknown>).event_sha256 = eventSha256;
    writeEvent(eventsDir, taskId, event); return event;
}

export function writePassedLifecycleWithReviewRecorded(
    eventsDir: string,
    taskId: string,
    reviewRecordedDetails: Record<string, unknown>,
    lateReviewRecordedPosition: 'none' | 'after-review-gate' | 'after-completion' = 'none'
): void {
    const entries: Array<{ event_type: string; details?: unknown; timestamp_utc?: string }> = [
        'TASK_MODE_ENTERED',
        'RULE_PACK_LOADED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        'DOC_IMPACT_ASSESSED',
        'COMPLETION_GATE_PASSED'
    ].map((event_type) => ({ event_type }));
    entries.splice(lateReviewRecordedPosition === 'after-completion' ? entries.length : 7, 0, {
        event_type: 'REVIEW_RECORDED',
        details: reviewRecordedDetails
    });
    if (lateReviewRecordedPosition === 'after-review-gate') {
        entries.splice(9, 0, {
            event_type: 'REVIEW_RECORDED',
            details: reviewRecordedDetails,
            timestamp_utc: '2026-04-28T00:00:00.000Z'
        });
    }
    writeIntegrityEventSequence(eventsDir, taskId, entries);
}

export function buildReviewRecordedTelemetryDetails(
    reviewsDir: string,
    taskId: string,
    reviewType: string
): Record<string, unknown> {
    const reviewPath = path.join(reviewsDir, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsDir, `${taskId}-${reviewType}-receipt.json`);
    const reviewArtifactSha256 = computeFileSha256(reviewPath);
    const receiptSha256 = computeFileSha256(receiptPath);
    const snapshotPath = (kind: string, sha256: string, ext: string) => path.join(reviewsDir, `${taskId}-${reviewType}-${kind}-${sha256}.${ext}`);
    const reviewArtifactSnapshotPath = snapshotPath('artifact', reviewArtifactSha256, 'md');
    const receiptSnapshotPath = snapshotPath('receipt', receiptSha256, 'json');
    fs.copyFileSync(reviewPath, reviewArtifactSnapshotPath); fs.copyFileSync(receiptPath, receiptSnapshotPath);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    return {
        task_id: taskId,
        review_type: reviewType,
        reused_existing_review: receipt.reused_existing_review === true,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        review_context_sha256: receipt.review_context_sha256,
        review_artifact_sha256: reviewArtifactSha256,
        reviewer_execution_mode: receipt.reviewer_execution_mode,
        reviewer_identity: receipt.reviewer_identity,
        reviewer_provenance: receipt.reviewer_provenance,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256
    };
}

export function writeActiveCompletionLock(reviewsDir: string, taskId: string): string {
    const lockPath = path.join(reviewsDir, `${taskId}-completion-gate.lock`);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
    return lockPath;
}

export function writeWorkflowConfig(
    repoRoot: string,
    enabled: boolean,
    reviewExecutionPolicyMode: 'parallel_all' | 'test_after_code' | 'code_first_optional' | 'strict_sequential' = 'code_first_optional'
): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = enabled;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = {
        mode: reviewExecutionPolicyMode
    };
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'workflow-config.json'),
        JSON.stringify(config, null, 2),
        'utf8'
    );
}

export function writeProjectMemoryWorkflowConfig(repoRoot: string, enabled = true): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = enabled;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify(config, null, 2), 'utf8');
}

export function seedProjectMemory(repoRoot: string): void {
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nConfirmed project memory content.\n`, 'utf8');
    }
}

export function writeProjectMemoryImpactArtifact(repoRoot: string, taskId: string): void {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-preflight.json`);
    const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
    fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
    fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');
}

export function writePathsConfig(repoRoot: string, data: Record<string, unknown>): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'paths.json'),
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

export function writePassedLifecycle(eventsDir: string, taskId: string): void {
    const now = Date.parse('2026-04-29T00:00:00.000Z');
    [
        'TASK_MODE_ENTERED',
        'RULE_PACK_LOADED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        'DOC_IMPACT_ASSESSED',
        'COMPLETION_GATE_PASSED'
    ].forEach((eventType, index) => {
        writeEvent(eventsDir, taskId, {
            timestamp_utc: new Date(now + index * 1000).toISOString(),
            task_id: taskId,
            event_type: eventType,
            outcome: 'PASS',
            actor: 'gate',
            message: `${eventType} passed.`
        });
    });
}

export function makeIndependentReviewGateCheck(passToken: string, reviewerIdentity: string): Record<string, unknown> {
    return {
        required: true,
        skipped_by_override: false,
        verdict: passToken,
        pass_token: passToken,
        receipt_valid: true,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        reviewer_fallback_reason: null,
        trust_level: 'INDEPENDENT_AUDITED',
        reviewer_routing_policy: {
            delegation_required: true,
            expected_execution_mode: 'delegated_subagent',
            fallback_allowed: false,
            fallback_reason_required: false
        }
    };
}

export function makeReviewerInvocationProvenance(
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    reviewContextSha256: string
): Record<string, unknown> {
    return {
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 10,
        prev_event_sha256: null,
        event_sha256: 'c'.repeat(64),
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        routing_event_sha256: 'd'.repeat(64)
    };
}

export function makeDelegatedRouting(reviewerIdentity = 'agent:code-reviewer', overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        actual_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        fallback_reason: null,
        capability_level: 'delegation_required',
        delegation_required: true,
        expected_execution_mode: 'delegated_subagent',
        fallback_allowed: false,
        fallback_reason_required: false,
        ...overrides
    };
}

export function writeRequiredCodeScenario(
    tmpDir: string,
    eventsDir: string,
    reviewsDir: string,
    taskId: string,
    changedLinesTotal = 20
): string {
    writeWorkflowConfig(tmpDir, false);
    writePassedLifecycle(eventsDir, taskId);
    writePreflight(reviewsDir, taskId, {
        mode: 'FULL_PATH',
        changed_files: ['src/gates/task-audit-summary.ts'],
        metrics: { changed_lines_total: changedLinesTotal },
        required_reviews: { code: true }
    });
    return computeFileSha256(path.join(reviewsDir, `${taskId}-preflight.json`));
}

export function buildCurrentTaskAuditSummary(
    taskId: string,
    tmpDir: string,
    eventsDir: string,
    reviewsDir: string
): TaskAuditSummaryResult {
    return buildTaskAuditSummary({
        taskId,
        repoRoot: tmpDir,
        eventsRoot: eventsDir,
        reviewsRoot: reviewsDir
    });
}

export type ReviewIntegrityAttestation = NonNullable<TaskAuditSummaryResult['final_closeout']['review_integrity_attestation']>;

export function assertReviewIntegrity(
    result: TaskAuditSummaryResult,
    expectedStatus: ReviewIntegrityAttestation['status'],
    options: {
        completionReviewAttested?: boolean;
        completionReviewAttestationNotRequired?: boolean;
        completionAllowed?: boolean;
        enforcementMode?: ReviewIntegrityAttestation['enforcement_mode'];
        issueIncludes?: string;
    } = {}
): ReviewIntegrityAttestation {
    const attestation = result.final_closeout.review_integrity_attestation;
    assert.ok(attestation);
    assert.equal(attestation.status, expectedStatus);
    assert.equal(attestation.completion_allowed, options.completionAllowed ?? true);
    if (options.enforcementMode) {
        assert.equal(attestation.enforcement_mode, options.enforcementMode);
    }
    if (options.completionReviewAttested !== undefined) {
        assert.equal(attestation.completion_review_attested, options.completionReviewAttested);
    }
    if (options.completionReviewAttestationNotRequired !== undefined) {
        assert.equal(
            attestation.completion_review_attestation_not_required,
            options.completionReviewAttestationNotRequired
        );
    }
    if (options.issueIncludes) {
        assert.ok(
            attestation.observed_issues.some((issue) => issue.includes(options.issueIncludes || '')),
            options.issueIncludes
        );
    }
    return attestation;
}

export function assertReviewIntegrityBlocksFinalCloseout(
    result: TaskAuditSummaryResult,
    issueIncludes?: string
): ReviewIntegrityAttestation {
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.final_closeout.status, 'NOT_READY');
    assert.equal(result.final_closeout.artifact_state, 'NOT_READY');
    assert.equal(result.final_report_contract.status, 'NOT_READY');
    assert.match(result.final_report_contract.blocker || '', /Review integrity blocked final closeout/);
    assert.ok(result.blockers.some((blocker) => blocker.gate === 'review-integrity'));
    return assertReviewIntegrity(result, 'DEGRADED_OR_UNVERIFIABLE', {
        completionAllowed: false,
        completionReviewAttested: false,
        enforcementMode: 'BLOCKING',
        issueIncludes
    });
}

export function writeCurrentIndependentReviewFixture(options: {
    reviewsDir: string;
    taskId: string;
    preflightSha256: string;
    reviewType?: string;
    passToken?: string;
    reviewerIdentity?: string;
    reviewContent?: string;
    routing?: Record<string, unknown> | null;
    receiptOverrides?: Record<string, unknown>;
    provenance?: Record<string, unknown> | null;
    reviewGateCheckIdentity?: string;
    reviewGateCheckOverrides?: Record<string, unknown>;
}): { reviewContent: string; reviewContextSha256: string } {
    const reviewType = options.reviewType || 'code';
    const passToken = options.passToken || 'REVIEW PASSED';
    const reviewerIdentity = options.reviewerIdentity || 'agent:code-reviewer';
    const reviewContent = options.reviewContent || `# ${reviewType} Review\n${passToken}`;
    writeArtifact(options.reviewsDir, options.taskId, `-${reviewType}.md`, reviewContent);
    writeArtifact(options.reviewsDir, options.taskId, `-${reviewType}-review-context.json`, {
        task_id: options.taskId,
        review_type: reviewType,
        ...(options.routing === null
            ? {}
            : { reviewer_routing: options.routing || makeDelegatedRouting(reviewerIdentity) })
    });
    const reviewContextSha256 = computeFileSha256(path.join(options.reviewsDir, `${options.taskId}-${reviewType}-review-context.json`));
    const provenance = options.provenance === undefined
        ? makeReviewerInvocationProvenance(options.taskId, reviewType, reviewerIdentity, reviewContextSha256)
        : options.provenance;
    writeArtifact(options.reviewsDir, options.taskId, `-${reviewType}-receipt.json`, {
        schema_version: 2,
        task_id: options.taskId,
        review_type: reviewType,
        preflight_sha256: options.preflightSha256,
        review_context_sha256: reviewContextSha256,
        review_artifact_sha256: createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        reviewer_fallback_reason: null,
        reviewer_provenance: provenance,
        trust_level: 'INDEPENDENT_AUDITED',
        ...(options.receiptOverrides || {})
    });
    writeArtifact(options.reviewsDir, options.taskId, '-review-gate.json', {
        task_id: options.taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: options.preflightSha256,
        required_reviews: { [reviewType]: true },
        verdicts: { [reviewType]: passToken },
        review_checks: {
            [reviewType]: {
                ...makeIndependentReviewGateCheck(
                    passToken,
                    options.reviewGateCheckIdentity || reviewerIdentity
                ),
                ...(options.reviewGateCheckOverrides || {})
            }
        }
    });
    return { reviewContent, reviewContextSha256 };
}
