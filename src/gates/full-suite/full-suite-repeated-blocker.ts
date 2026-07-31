import { createHash } from 'node:crypto';

import { isPlainRecord } from '../../core/records';
import { getHeadCommit } from './full-suite-repair-manifest';
import {
    findFullSuiteRepairChildHandoffState
} from './full-suite-repair-decomposition';
import { readImmutableRegularFileSnapshot } from './full-suite-repair-capture';
import type {
    FullSuiteRepeatedBlockerAnalysis,
    FullSuiteTimeoutBlockerIdentity,
    FullSuiteValidationCycleBinding
} from './full-suite-validation-types';

const FULL_SUITE_TIMEOUT_GATE = 'full-suite-validation' as const;
const FULL_SUITE_TIMEOUT_FAILURE_CLASS = 'timeout_retry_exhausted' as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface RepairAncestor {
    task_id: string;
    full_suite_artifact_path: string;
}

export interface FullSuiteTimeoutBlockerEvidence {
    blocker_identity: FullSuiteTimeoutBlockerIdentity;
    repeated_blocker_analysis: FullSuiteRepeatedBlockerAnalysis | null;
}

function sha256Json(value: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function normalizeGitObjectId(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return GIT_OBJECT_ID_PATTERN.test(normalized) ? normalized : null;
}

function resolveScopeSha256(cycleBinding: FullSuiteValidationCycleBinding): string {
    return normalizeSha256(cycleBinding.scope_binding?.scope_sha256)
        || normalizeSha256(cycleBinding.scope_binding?.scope_content_sha256)
        || (() => {
            throw new Error('Full-suite timeout blocker identity requires a current scope sha256.');
        })();
}

export function buildFullSuiteTimeoutBlockerIdentity(options: {
    sourceTaskId: string;
    observedTaskId: string;
    baseCommit: string;
    scopeSha256: string;
}): FullSuiteTimeoutBlockerIdentity {
    const sourceTaskId = String(options.sourceTaskId || '').trim();
    const observedTaskId = String(options.observedTaskId || '').trim();
    const baseCommit = normalizeGitObjectId(options.baseCommit);
    const scopeSha256 = normalizeSha256(options.scopeSha256);
    if (!sourceTaskId || !observedTaskId || !baseCommit || !scopeSha256) {
        throw new Error('Full-suite timeout blocker identity requires task ids, a full base commit, and a scope sha256.');
    }
    const fingerprintSha256 = sha256Json({
        source_task_id: sourceTaskId,
        base_commit: baseCommit,
        scope_sha256: scopeSha256,
        gate: FULL_SUITE_TIMEOUT_GATE,
        failure_class: FULL_SUITE_TIMEOUT_FAILURE_CLASS
    });
    return {
        schema_version: 1,
        source_task_id: sourceTaskId,
        observed_task_id: observedTaskId,
        base_commit: baseCommit,
        scope_sha256: scopeSha256,
        gate: FULL_SUITE_TIMEOUT_GATE,
        failure_class: FULL_SUITE_TIMEOUT_FAILURE_CLASS,
        fingerprint_sha256: fingerprintSha256
    };
}

function parseBlockerIdentity(value: unknown): FullSuiteTimeoutBlockerIdentity | null {
    if (!isPlainRecord(value) || value.schema_version !== 1) {
        return null;
    }
    const sourceTaskId = String(value.source_task_id || '').trim();
    const observedTaskId = String(value.observed_task_id || '').trim();
    const baseCommit = normalizeGitObjectId(value.base_commit);
    const scopeSha256 = normalizeSha256(value.scope_sha256);
    const fingerprintSha256 = normalizeSha256(value.fingerprint_sha256);
    if (
        !sourceTaskId
        || !observedTaskId
        || !baseCommit
        || !scopeSha256
        || !fingerprintSha256
        || value.gate !== FULL_SUITE_TIMEOUT_GATE
        || value.failure_class !== FULL_SUITE_TIMEOUT_FAILURE_CLASS
    ) {
        return null;
    }
    const rebuilt = buildFullSuiteTimeoutBlockerIdentity({
        sourceTaskId,
        observedTaskId,
        baseCommit,
        scopeSha256
    });
    return rebuilt.fingerprint_sha256 === fingerprintSha256 ? rebuilt : null;
}

function collectRepairAncestors(repoRoot: string, taskId: string): RepairAncestor[] {
    const ancestors: RepairAncestor[] = [];
    const visited = new Set<string>([taskId]);
    let currentTaskId = taskId;
    while (true) {
        const handoff = findFullSuiteRepairChildHandoffState(repoRoot, currentTaskId);
        if (!handoff || visited.has(handoff.parent_task_id)) {
            return ancestors;
        }
        visited.add(handoff.parent_task_id);
        ancestors.push({
            task_id: handoff.parent_task_id,
            full_suite_artifact_path: handoff.full_suite_artifact_path
        });
        currentTaskId = handoff.parent_task_id;
    }
}

function readAncestorBlockerIdentity(repoRoot: string, ancestor: RepairAncestor): FullSuiteTimeoutBlockerIdentity {
    try {
        const snapshot = readImmutableRegularFileSnapshot({
            repoRoot,
            filePath: ancestor.full_suite_artifact_path,
            label: `Full-suite artifact for repair ancestor ${ancestor.task_id}`
        });
        const artifact = JSON.parse(snapshot.content.toString('utf8')) as unknown;
        if (!isPlainRecord(artifact)) {
            throw new Error('artifact root is not a JSON object');
        }
        const timeoutPolicy = isPlainRecord(artifact.timeout_policy) ? artifact.timeout_policy : null;
        const blockerIdentity = parseBlockerIdentity(timeoutPolicy?.blocker_identity);
        if (!blockerIdentity) {
            throw new Error('artifact has no valid timeout blocker identity');
        }
        return blockerIdentity;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Cannot safely evaluate repeated blocker ancestry for ${ancestor.task_id}: ${message}`
        );
    }
}

export function resolveFullSuiteTimeoutBlockerEvidence(options: {
    repoRoot: string;
    taskId: string;
    cycleBinding: FullSuiteValidationCycleBinding;
}): FullSuiteTimeoutBlockerEvidence {
    const ancestors = collectRepairAncestors(options.repoRoot, options.taskId);
    const sourceTaskId = ancestors.at(-1)?.task_id || options.taskId;
    const blockerIdentity = buildFullSuiteTimeoutBlockerIdentity({
        sourceTaskId,
        observedTaskId: options.taskId,
        baseCommit: getHeadCommit(options.repoRoot),
        scopeSha256: resolveScopeSha256(options.cycleBinding)
    });
    const repeatedAncestor = ancestors.find((ancestor) => (
        readAncestorBlockerIdentity(options.repoRoot, ancestor)?.fingerprint_sha256
        === blockerIdentity.fingerprint_sha256
    ));
    return {
        blocker_identity: blockerIdentity,
        repeated_blocker_analysis: repeatedAncestor
            ? {
                schema_version: 1,
                status: 'REPEATED_BLOCKER',
                source_task_id: sourceTaskId,
                observed_task_id: options.taskId,
                matched_ancestor_task_id: repeatedAncestor.task_id,
                blocker_fingerprint_sha256: blockerIdentity.fingerprint_sha256,
                base_commit: blockerIdentity.base_commit,
                scope_sha256: blockerIdentity.scope_sha256,
                gate: blockerIdentity.gate,
                failure_class: blockerIdentity.failure_class,
                required_resolution: 'TRUE_DECOMPOSITION_OR_EXPLICIT_RECOVERY_DECISION'
            }
            : null
    };
}
