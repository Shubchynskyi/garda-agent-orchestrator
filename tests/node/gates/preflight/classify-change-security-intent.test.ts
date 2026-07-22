import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import {
    classifySecurityReviewIntent,
    hasSecurityReviewIntent,
    type SecurityReviewIntentReason
} from '../../../../src/gates/preflight/classify-change-intent';
import { mergeReviewPolicy } from '../../../../src/policy/profile-resolver';
import {
    defaultCapabilities,
    makeConfig
} from './classify-change-test-support';

function classifyRuntimeIntent(
    taskIntent: string,
    reviewCapabilities = defaultCapabilities,
    normalizedFiles = ['src/workflow/recovery.ts']
) {
    return classifyChange({
        normalizedFiles,
        taskIntent,
        changedLinesTotal: 24,
        additionsTotal: 16,
        deletionsTotal: 8,
        renameCount: 0,
        detectionSource: 'explicit_changed_files',
        classificationConfig: makeConfig(),
        reviewCapabilities
    });
}

describe('security review task-intent classification', () => {
    it('recognizes the exact structured follow-up shape that created T-979-17-F1', () => {
        const taskIntent =
            '[security] Follow up medium F-001: Dirty-baseline command scope preserves outside-root paths';

        const result = classifyRuntimeIntent(taskIntent);

        assert.equal(result.triggers.security, true);
        assert.equal(result.triggers.security_intent, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix',
            'path_containment_remediation'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('treats a structured security prefix as explicit intent without substantive wording', () => {
        const taskIntent = '[security] Follow up low F-009: Clarify the task wording';

        const classification = classifySecurityReviewIntent(taskIntent);
        const result = classifyRuntimeIntent(taskIntent);

        assert.deepEqual(classification, {
            triggered: true,
            reasons: ['explicit_security_follow_up_prefix']
        });
        assert.equal(result.triggers.security_intent, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('recognizes equivalent structured and localized security follow-up titles', () => {
        const cases = [
            '[SECURITY] Follow-up high F-002: Reject a forged reviewer identity',
            'Security follow-up: bind delegated reviewer identity to the current attempt',
            '[security] Исправить выход пути за корень репозитория'
        ];

        for (const taskIntent of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.equal(classification.triggered, true, taskIntent);
            assert.ok(
                classification.reasons.includes('explicit_security_follow_up_prefix'),
                taskIntent
            );
            assert.equal(hasSecurityReviewIntent(taskIntent), true, taskIntent);
        }
    });

    it('recognizes deliberate security-review requests and substantive remediation intent', () => {
        const cases = new Map<string, SecurityReviewIntentReason>([
            [
                'Require security review for explicit security follow-up intent',
                'explicit_security_review_request'
            ],
            [
                'Enforce the authorization boundary before privileged recovery',
                'authorization_boundary_remediation'
            ],
            [
                'Bind provider attestation at the delegated-review trust boundary',
                'trust_boundary_remediation'
            ],
            [
                'Reject adversarial path traversal and symlink escape inputs',
                'adversarial_path_remediation'
            ],
            [
                'Keep dirty-baseline paths contained inside the repository root',
                'path_containment_remediation'
            ]
        ]);

        for (const [taskIntent, expectedReason] of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.equal(classification.triggered, true, taskIntent);
            assert.ok(classification.reasons.includes(expectedReason), taskIntent);
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, true, taskIntent);
        }
    });

    it('recognizes recovery, evidence-integrity, and artifact-trust intent on neutral runtime paths', () => {
        const cases = new Map<string, SecurityReviewIntentReason>([
            ['Fix recovery state replay in the catalog module', 'recovery_control_plane_change'],
            ['Recovery flow must reject stale evidence in the catalog module', 'recovery_control_plane_change'],
            ['Validate evidence integrity before catalog state is accepted', 'evidence_integrity_change'],
            ['Bind artifact trust to canonical catalog reconstruction', 'artifact_trust_change']
        ]);

        for (const [taskIntent, expectedReason] of cases) {
            const result = classifyRuntimeIntent(taskIntent, defaultCapabilities, ['src/domain/catalog.ts']);

            assert.equal(result.triggers.security_intent, true, taskIntent);
            assert.ok(result.triggers.security_intent_reasons.includes(expectedReason), taskIntent);
            assert.equal(result.required_reviews.security, true, taskIntent);
        }
    });

    it('does not trigger from vague or incidental words in unrelated runtime tasks', () => {
        const cases = [
            'Update security documentation wording in the runtime report',
            'Refactor the path formatter for shorter labels',
            'Preserve operator trust in the release notes',
            'Rename the boundary helper used by layout rendering',
            'Add a follow-up section to the task summary',
            'Restart review cycle after compile remediation',
            'Restart review cycle with API review blocked behind code'
        ];

        for (const taskIntent of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.deepEqual(classification, {
                triggered: false,
                reasons: []
            }, taskIntent);
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, false, taskIntent);
        }
    });

    it('keeps intent evidence alongside stricter path-based security triggers', () => {
        const result = classifyRuntimeIntent(
            '[security] Follow up high F-003: Enforce authorization boundary checks',
            defaultCapabilities,
            ['src/security/authorization/recovery.ts']
        );

        assert.equal(result.triggers.security, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix',
            'authorization_boundary_remediation'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('fails closed when a custom profile tries to disable security for code-changing scope', () => {
        const { merged, floorsApplied } = mergeReviewPolicy(
            {
                code: false,
                db: false,
                security: false,
                refactor: false
            },
            { ...defaultCapabilities, security: false },
            true
        );

        assert.equal(merged.security, true);
        assert.ok(floorsApplied.some((reason) => reason.startsWith('security:')));
    });

    it('keeps an explicit security intent required when the capability catalog disables the lane', () => {
        const result = classifyRuntimeIntent(
            '[security] Follow up medium F-004: Reject an outside-root path alias',
            { ...defaultCapabilities, security: false }
        );

        assert.equal(result.metrics.review_capabilities.security, false);
        assert.equal(result.triggers.security, true);
        assert.equal(result.required_reviews.security, true);
    });
});
