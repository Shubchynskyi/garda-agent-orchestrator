import * as fs from 'node:fs';
import * as path from 'node:path';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { resolveTaskHistoryLedgerPath } from '../../gate-runtime/task-history-ledger';
import { fileSha256, toPosix } from '../shared/helpers';
import { parseTimestamp, type TaskCycleBindingSnapshot } from '../task-events-summary/task-events-summary';
import { type ProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact';
import {
    collectKnownRequiredReviewTypes,
    safeReadJson,
    type BlockerEntry,
    type EvidenceArtifact
} from './task-audit-summary-collectors';
import { type TaskAuditEvent } from './task-audit-summary-lifecycle';

// Artifact name patterns relative to reviews root, keyed by kind.
const ARTIFACT_PATTERNS: ReadonlyArray<{ kind: string; suffix: string }> = [
    { kind: 'task-mode', suffix: '-task-mode.json' },
    { kind: 'rule-pack', suffix: '-rule-pack.json' },
    { kind: 'handshake', suffix: '-handshake.json' },
    { kind: 'shell-smoke', suffix: '-shell-smoke.json' },
    { kind: 'preflight', suffix: '-preflight.json' },
    { kind: 'compile-gate', suffix: '-compile-gate.json' },
    { kind: 'compile-output', suffix: '-compile-output.log' },
    { kind: 'coherent-cycle-restart', suffix: '-coherent-cycle-restart.json' },
    { kind: 'review-cycle-restart', suffix: '-review-cycle-restart.json' },
    { kind: 'review-gate', suffix: '-review-gate.json' },
    { kind: 'doc-impact', suffix: '-doc-impact.json' },
    { kind: 'full-suite-validation', suffix: '-full-suite-validation.json' },
    { kind: 'full-suite-output', suffix: '-full-suite-output.log' },
    { kind: 'optional-skill-selection', suffix: '-optional-skill-selection.json' },
    { kind: 'final-closeout-json', suffix: '-final-closeout.json' },
    { kind: 'final-closeout-markdown', suffix: '-final-closeout.md' },
    { kind: 'final-user-report', suffix: '-final-user-report.md' },
    { kind: 'no-op', suffix: '-no-op.json' },
    { kind: 'code-review', suffix: '-code.md' },
    { kind: 'code-review-context', suffix: '-code-review-context.json' },
    { kind: 'code-receipt', suffix: '-code-receipt.json' },
    { kind: 'db-review', suffix: '-db.md' },
    { kind: 'db-review-context', suffix: '-db-review-context.json' },
    { kind: 'db-receipt', suffix: '-db-receipt.json' },
    { kind: 'security-review', suffix: '-security.md' },
    { kind: 'security-review-context', suffix: '-security-review-context.json' },
    { kind: 'security-receipt', suffix: '-security-receipt.json' },
    { kind: 'refactor-review', suffix: '-refactor.md' },
    { kind: 'refactor-review-context', suffix: '-refactor-review-context.json' },
    { kind: 'refactor-receipt', suffix: '-refactor-receipt.json' },
    { kind: 'test-review', suffix: '-test.md' },
    { kind: 'test-review-context', suffix: '-test-review-context.json' },
    { kind: 'test-receipt', suffix: '-test-receipt.json' },
    { kind: 'api-review', suffix: '-api.md' },
    { kind: 'api-review-context', suffix: '-api-review-context.json' },
    { kind: 'api-receipt', suffix: '-api-receipt.json' },
    { kind: 'performance-review', suffix: '-performance.md' },
    { kind: 'performance-review-context', suffix: '-performance-review-context.json' },
    { kind: 'performance-receipt', suffix: '-performance-receipt.json' },
    { kind: 'infra-review', suffix: '-infra.md' },
    { kind: 'infra-review-context', suffix: '-infra-review-context.json' },
    { kind: 'infra-receipt', suffix: '-infra-receipt.json' },
    { kind: 'dependency-review', suffix: '-dependency.md' },
    { kind: 'dependency-review-context', suffix: '-dependency-review-context.json' },
    { kind: 'dependency-receipt', suffix: '-dependency-receipt.json' }
];

function buildRequiredReviewBlocker(reviewType: string, taskId: string, reviewsRoot: string): BlockerEntry | null {
    const gate = `${reviewType}-review`;
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const reviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const hasReceipt = fs.existsSync(receiptPath);
    const hasReview = fs.existsSync(reviewPath);

    if (!hasReceipt && !hasReview) {
        return { gate, reason: `Required ${reviewType} review artifact not found` };
    }
    if (!hasReceipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt not found (review markdown exists but receipt is missing)`
        };
    }
    if (!hasReview) {
        return {
            gate,
            reason: `Required ${reviewType} review markdown not found (receipt exists but review document is missing)`
        };
    }

    const receipt = safeReadJson(receiptPath);
    if (!receipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt is malformed or unreadable`
        };
    }
    if (receipt.task_id !== taskId) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt belongs to a different task: ${receipt.task_id}`
        };
    }
    if (receipt.review_type !== reviewType) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt has mismatched review type: ${receipt.review_type}`
        };
    }
    if (typeof receipt.review_artifact_sha256 === 'string' && receipt.review_artifact_sha256) {
        const actualHash = fileSha256(reviewPath);
        if (actualHash && receipt.review_artifact_sha256 !== actualHash) {
            return {
                gate,
                reason: `Required ${reviewType} review artifact was modified after receipt was issued`
            };
        }
    }

    return null;
}

function shouldValidateRequiredReviewArtifactForCurrentCycle(
    reviewType: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const compileGateTime = parseTimestamp(currentCycle.compile_gate_timestamp).getTime();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventTime = parseTimestamp(event.timestamp_utc).getTime();
        if (eventTime > 0 && compileGateTime > 0 && eventTime < compileGateTime) {
            continue;
        }

        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (
            eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || eventType === 'REVIEW_GATE_FAILED'
            || eventType === 'COMPLETION_GATE_PASSED'
            || eventType === 'COMPLETION_GATE_FAILED'
        ) {
            return true;
        }

        if (eventType !== 'REVIEW_RECORDED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        const recordedReviewType = String(
            details?.review_type
            || details?.reviewType
            || ''
        ).trim().toLowerCase();
        if (recordedReviewType === reviewType) {
            return true;
        }
    }

    return false;
}

export function collectRequiredReviewBlockers(
    requiredReviews: Record<string, boolean>,
    taskId: string,
    reviewsRoot: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null
): BlockerEntry[] {
    return withReviewArtifactReadBarrier(reviewsRoot, () => (
        collectKnownRequiredReviewTypes(requiredReviews)
            .flatMap((reviewType) => {
                if (!shouldValidateRequiredReviewArtifactForCurrentCycle(reviewType, events, currentCycle)) {
                    return [];
                }
                const blocker = buildRequiredReviewBlocker(reviewType, taskId, reviewsRoot);
                return blocker ? [blocker] : [];
            })
    ));
}

export function collectEvidenceArtifacts(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    taskEventFile: string,
    projectMemoryImpact: ProjectMemoryImpactLifecycleEvidence
): EvidenceArtifact[] {
    const evidence = withReviewArtifactReadBarrier(reviewsRoot, () => (
        ARTIFACT_PATTERNS.map(({ kind, suffix }) => {
            const artifactPath = path.join(reviewsRoot, `${taskId}${suffix}`);
            const exists = fs.existsSync(artifactPath);
            return {
                kind,
                path: toPosix(artifactPath),
                exists,
                sha256: exists ? fileSha256(artifactPath) : null
            };
        })
    ));

    if (projectMemoryImpact.required || projectMemoryImpact.evidence_status !== 'NOT_REQUIRED') {
        for (const [kind, artifactPath] of [
            ['project-memory-impact', projectMemoryImpact.artifact_path],
            ['project-memory-update', projectMemoryImpact.update_artifact_path]
        ] as const) {
            const resolvedPath = path.resolve(repoRoot, artifactPath);
            const exists = fs.existsSync(resolvedPath);
            evidence.push({
                kind,
                path: toPosix(resolvedPath),
                exists,
                sha256: exists ? fileSha256(resolvedPath) : null
            });
        }
    }

    evidence.push({
        kind: 'task-events',
        path: toPosix(taskEventFile),
        exists: fs.existsSync(taskEventFile),
        sha256: fs.existsSync(taskEventFile) ? fileSha256(taskEventFile) : null
    });
    evidence.push({
        kind: 'task-ledger',
        path: toPosix(resolveTaskHistoryLedgerPath(path.dirname(path.dirname(reviewsRoot)), taskId)),
        exists: false,
        sha256: null
    });

    return evidence;
}
