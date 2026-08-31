import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    resolvePersistedRemediationReviewExecutionAuthority
} from '../../../../src/gates/review-remediation/review-remediation-execution-authority';
import {
    resolveAuthoritativeReviewRemediationDecision
} from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';

test('reconstructs remediation review execution authority only from an integrity-valid restart event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-remediation-authority-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const taskId = 'T-992-remediation-authority';
    const preflightSha256 = createHash('sha256').update('preflight').digest('hex');
    const classification = {
        source: 'runtime_fix' as const,
        classification: {
            category: 'production',
            reason: 'Runtime remediation requires a fresh code lane.',
            blocked_before_reuse: false,
            invalidated_review_types: ['code']
        }
    };
    const decision = resolveAuthoritativeReviewRemediationDecision({
        taskId,
        currentReviewType: 'code',
        classification,
        requiredReviews: { code: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    const decisionWithoutHash = {
        ...decision,
        preflight_sha256: preflightSha256
    } as Record<string, unknown>;
    delete decisionWithoutHash.decision_sha256;
    const boundDecision: Record<string, unknown> & { decision_sha256: string } = {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash)
    };
    appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Review cycle restarted.', {
        task_id: taskId,
        event_type: 'REVIEW_CYCLE_RESTARTED',
        status: 'PASSED',
        preflight_sha256: preflightSha256,
        authoritative_review_decision: boundDecision,
        authoritative_review_classification: classification
    });
    const reviewExecution = {
        source: 'remediation_full',
        mode: 'FULL'
    } as Parameters<typeof resolvePersistedRemediationReviewExecutionAuthority>[0]['reviewExecution'];

    const authority = resolvePersistedRemediationReviewExecutionAuthority({
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        fullReviewScope: ['src/app.ts'],
        reviewExecution
    });
    assert.equal(authority?.authoritativeDecisionSha256, boundDecision.decision_sha256);
    assert.equal(authority?.authoritativeClassificationSha256, boundDecision.classification_sha256);

    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.appendFileSync(timelinePath, '{"forged":true}\n', 'utf8');
    assert.equal(resolvePersistedRemediationReviewExecutionAuthority({
        reviewsRoot,
        taskId,
        reviewType: 'code',
        preflightSha256,
        fullReviewScope: ['src/app.ts'],
        reviewExecution
    }), null);
});
