import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolvePathInsideRepo } from '../../core/orchestrator-paths';
import { fileSha256 } from '../../gate-runtime/hash';
import { isResolvedReviewerIdentity } from '../../gate-runtime/review/reviewer-identity-contract';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { serializeSemanticCycleValue } from './semantic-cycle-snapshot';
import {
    assessSemanticCycleCommitEventBinding,
    readSemanticCycleRebindManifest
} from './semantic-cycle-transaction';
import type {
    SemanticCycleRebindManifest,
    SemanticCycleReboundArtifact
} from './semantic-cycle-transaction-types';

export type SemanticCycleResumeRoutingStatus =
    | 'ABSENT'
    | 'REUSABLE'
    | 'RECOVERY_REQUIRED'
    | 'RUNTIME_UPGRADE_REQUIRED';

export interface SemanticCycleResumeRoutingState {
    status: SemanticCycleResumeRoutingStatus;
    reason: string;
    manifest_path: string;
    accepted_compile: boolean;
    accepted_full_suite: boolean;
    accepted_review_types: string[];
    target_task_event_sequence: number | null;
    target_cycle_sha256: string | null;
}

export interface ReadSemanticCycleResumeRoutingStateOptions {
    repo_root: string;
    task_id: string;
    manifest_path: string;
    task_events_path: string;
    preflight_path: string;
}

const LIFECYCLE_INVALIDATING_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'COMPILE_GATE_FAILED',
    'FULL_SUITE_VALIDATION_PASSED',
    'FULL_SUITE_VALIDATION_FAILED',
    'FULL_SUITE_VALIDATION_SKIPPED',
    'COHERENT_CYCLE_RESTARTED',
    'REVIEW_CYCLE_RESTARTED',
    'IMPLEMENTATION_STARTED'
]);

function buildState(
    options: ReadSemanticCycleResumeRoutingStateOptions,
    status: SemanticCycleResumeRoutingStatus,
    reason: string
): SemanticCycleResumeRoutingState {
    return {
        status,
        reason,
        manifest_path: options.manifest_path.replace(/\\/gu, '/'),
        accepted_compile: false,
        accepted_full_suite: false,
        accepted_review_types: [],
        target_task_event_sequence: null,
        target_cycle_sha256: null
    };
}

function validateBoundArtifact(
    repoRoot: string,
    artifact: SemanticCycleReboundArtifact
): string | null {
    let resolvedPath: string | null = null;
    try {
        resolvedPath = resolvePathInsideRepo(artifact.source_path, repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
    } catch (error: unknown) {
        return `Rebound ${artifact.artifact_class} evidence is unavailable: ${
            error instanceof Error ? error.message : String(error)
        }`;
    }
    const relativePath = resolvedPath
        ? path.relative(repoRoot, resolvedPath).replace(/\\/gu, '/')
        : '';
    if (!resolvedPath || relativePath !== artifact.source_path) {
        return `Rebound ${artifact.artifact_class} evidence path is not canonically bound.`;
    }
    return fileSha256(resolvedPath) === artifact.source_sha256
        ? null
        : `Rebound ${artifact.artifact_class} evidence content changed: ${artifact.source_path}.`;
}

function collectArtifactViolations(
    repoRoot: string,
    manifest: SemanticCycleRebindManifest
): string[] {
    return manifest.artifacts
        .map((artifact) => validateBoundArtifact(repoRoot, artifact))
        .filter((entry): entry is string => Boolean(entry));
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function validateReviewReceiptBinding(
    repoRoot: string,
    taskId: string,
    manifest: SemanticCycleRebindManifest,
    receiptArtifact: SemanticCycleReboundArtifact
): string[] {
    const reviewType = receiptArtifact.review_type || '';
    const receiptPath = path.resolve(repoRoot, receiptArtifact.source_path);
    const receipt = readJsonRecord(receiptPath);
    const context = manifest.artifacts.find((artifact) => (
        artifact.artifact_class === 'review_context' && artifact.review_type === reviewType
    ));
    if (!receipt || !context) {
        return [`Rebound '${reviewType}' receipt or review context is unreadable.`];
    }
    const violations: string[] = [];
    if (receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        violations.push(`Rebound '${reviewType}' receipt identity does not match the current task and lane.`);
    }
    if (receipt.review_context_sha256 !== context.source_sha256) {
        violations.push(`Rebound '${reviewType}' receipt does not bind the authenticated review context.`);
    }
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim();
    const provenance = receipt.reviewer_provenance as Record<string, unknown> | undefined;
    if (
        !isResolvedReviewerIdentity(reviewerIdentity)
        || String(provenance?.reviewer_identity || '').trim() !== reviewerIdentity
    ) {
        violations.push(`Rebound '${reviewType}' receipt lacks one resolved provenance-bound reviewer identity.`);
    }
    const reviewArtifactPath = path.join(path.dirname(receiptPath), `${taskId}-${reviewType}.md`);
    if (!fs.existsSync(reviewArtifactPath) || fileSha256(reviewArtifactPath) !== receipt.review_artifact_sha256) {
        violations.push(`Rebound '${reviewType}' review artifact no longer matches its accepted receipt.`);
    }
    return violations;
}

function collectReceiptBindingViolations(
    repoRoot: string,
    taskId: string,
    manifest: SemanticCycleRebindManifest
): string[] {
    return manifest.artifacts
        .filter((artifact) => artifact.artifact_class === 'review_receipt')
        .flatMap((artifact) => validateReviewReceiptBinding(repoRoot, taskId, manifest, artifact));
}

function collectLifecycleViolations(
    options: ReadSemanticCycleResumeRoutingStateOptions,
    manifest: SemanticCycleRebindManifest
): string[] {
    const anchors = new Map<number, string>();
    const invalidatingEvents: string[] = [];
    let latestPreflightDetails: Record<string, unknown> | null = null;
    const inspection = inspectTaskEventFile(options.task_events_path, options.task_id, {
        onIntegrityEvent: (event) => {
            const integrity = event.integrity as Record<string, unknown>;
            const sequence = Number(integrity.task_sequence);
            anchors.set(sequence, String(integrity.event_sha256 || ''));
            const eventType = String(event.event_type || '').trim().toUpperCase();
            if (sequence <= manifest.target_position.task_event_sequence && eventType === 'PREFLIGHT_CLASSIFIED') {
                latestPreflightDetails = readRecord(event.details);
            }
            if (
                sequence > manifest.target_position.task_event_sequence
                && LIFECYCLE_INVALIDATING_EVENTS.has(eventType)
            ) {
                invalidatingEvents.push(`${eventType} seq ${sequence}`);
            }
        }
    });
    const violations = ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)
        ? []
        : [`Task-event authority is not verifiable: ${inspection.violations.join(' ')}`];
    if (anchors.get(manifest.source_position.task_event_sequence) !== manifest.source_position.cycle_sha256) {
        violations.push('Semantic rebind source lifecycle position is not present in the authenticated task-event chain.');
    }
    if (anchors.get(manifest.target_position.task_event_sequence) !== manifest.target_position.cycle_sha256) {
        violations.push('Semantic rebind target lifecycle position is not present in the authenticated task-event chain.');
    }
    if (invalidatingEvents.length > 0) {
        violations.push(`Lifecycle advanced through a semantic invalidation boundary: ${invalidatingEvents.join(', ')}.`);
    }
    const commitBinding = assessSemanticCycleCommitEventBinding({
        repo_root: options.repo_root,
        task_id: options.task_id,
        manifest_path: options.manifest_path,
        task_events_path: options.task_events_path,
        manifest
    });
    if (commitBinding.status !== 'VALID') {
        violations.push(...commitBinding.violations);
    }
    violations.push(...collectCurrentPreflightViolations(options, latestPreflightDetails));
    return violations;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
    return serializeSemanticCycleValue(left) === serializeSemanticCycleValue(right);
}

function collectCurrentPreflightViolations(
    options: ReadSemanticCycleResumeRoutingStateOptions,
    eventDetails: Record<string, unknown> | null
): string[] {
    const preflight = readJsonRecord(options.preflight_path);
    if (!preflight || preflight.task_id !== options.task_id || !eventDetails) {
        return ['Current preflight is not authenticated by the semantic rebind target lifecycle.'];
    }
    let currentPath: string | null;
    let eventPath: string | null;
    try {
        currentPath = resolvePathInsideRepo(options.preflight_path, options.repo_root, { allowMissing: false });
        eventPath = resolvePathInsideRepo(String(eventDetails.output_path || ''), options.repo_root, { allowMissing: false });
    } catch {
        return ['Current preflight path is not canonically bound to the semantic rebind target lifecycle.'];
    }
    if (!currentPath || !eventPath) {
        return ['Current preflight path is not canonically bound to the semantic rebind target lifecycle.'];
    }
    const metrics = readRecord(preflight.metrics) || {};
    const bindings: Array<[string, unknown]> = [
        ['mode', preflight.mode],
        ['changed_files_count', metrics.changed_files_count],
        ['changed_lines_total', metrics.changed_lines_total],
        ['scope_sha256', metrics.scope_sha256],
        ['scope_content_sha256', metrics.scope_content_sha256],
        ['required_reviews', preflight.required_reviews],
        ['review_execution_policy', preflight.review_execution_policy],
        ['profile_selection', preflight.profile_selection],
        ['profile_guardrails', preflight.profile_guardrails],
        ['profile_policy_snapshot', preflight.profile_policy_snapshot],
        ['effective_review_snapshot', preflight.effective_review_snapshot],
        ['zero_diff_guard', preflight.zero_diff_guard]
    ];
    const mismatch = bindings.some(([key, value]) => (
        Object.prototype.hasOwnProperty.call(eventDetails, key)
        && !sameSemanticValue(eventDetails[key], value)
    ));
    return path.resolve(currentPath) === path.resolve(eventPath) && !mismatch
        ? []
        : ['Current preflight no longer matches its authenticated target lifecycle binding.'];
}

function acceptedReviewTypes(manifest: SemanticCycleRebindManifest): string[] {
    return [...new Set(manifest.artifacts
        .filter((artifact) => artifact.artifact_class === 'review_receipt' && artifact.review_type)
        .map((artifact) => artifact.review_type as string))]
        .sort();
}

function reusableState(
    options: ReadSemanticCycleResumeRoutingStateOptions,
    manifest: SemanticCycleRebindManifest
): SemanticCycleResumeRoutingState {
    return {
        status: 'REUSABLE',
        reason:
            `Authenticated semantic-cycle transaction '${manifest.transaction_id}' remains reusable at ` +
            `task-event seq ${manifest.target_position.task_event_sequence}.`,
        manifest_path: options.manifest_path.replace(/\\/gu, '/'),
        accepted_compile: manifest.artifacts.some((artifact) => artifact.artifact_class === 'compile'),
        accepted_full_suite: manifest.artifacts.some((artifact) => artifact.artifact_class === 'full_suite'),
        accepted_review_types: acceptedReviewTypes(manifest),
        target_task_event_sequence: manifest.target_position.task_event_sequence,
        target_cycle_sha256: manifest.target_position.cycle_sha256
    };
}

export function readSemanticCycleResumeRoutingState(
    options: ReadSemanticCycleResumeRoutingStateOptions
): SemanticCycleResumeRoutingState {
    if (!fs.existsSync(options.manifest_path)) {
        return buildState(options, 'ABSENT', 'No semantic-cycle rebind transaction is present.');
    }
    const validation = readSemanticCycleRebindManifest(options.repo_root, options.manifest_path);
    if (!validation.manifest) {
        return buildState(
            options,
            'RECOVERY_REQUIRED',
            `Semantic-cycle rebind transaction is unverifiable: ${validation.violations.join(' ')}`
        );
    }
    const manifest = validation.manifest;
    if (manifest.task_id !== options.task_id || manifest.status !== 'COMMITTED') {
        const runtimeUpgrade = manifest.audit.route === 'runtime_upgrade_required';
        return buildState(
            options,
            runtimeUpgrade ? 'RUNTIME_UPGRADE_REQUIRED' : 'RECOVERY_REQUIRED',
            runtimeUpgrade
                ? 'Semantic-cycle mutation was rejected because the active runtime is incompatible.'
                : 'Semantic-cycle transaction is not a committed binding for the current task.'
        );
    }
    const violations = [
        ...collectArtifactViolations(options.repo_root, manifest),
        ...collectReceiptBindingViolations(options.repo_root, options.task_id, manifest),
        ...collectLifecycleViolations(options, manifest)
    ];
    return violations.length > 0
        ? buildState(options, 'RECOVERY_REQUIRED', violations.join(' '))
        : reusableState(options, manifest);
}
