import { isCanonicalTaskId } from '../../core/task-ids';
import { stringSha256 } from '../../gate-runtime/hash';
import {
    SEMANTIC_CYCLE_BASE_BINDING_KEYS,
    SEMANTIC_CYCLE_BINDING_KEYS,
    SEMANTIC_CYCLE_CONTRACT_ID,
    SEMANTIC_CYCLE_REVIEW_BINDING_KEYS,
    SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION,
    type SemanticCycleBindingKey,
    type SemanticCycleLifecyclePosition,
    type SemanticCycleReviewLaneBinding,
    type SemanticCycleSnapshot,
    type SemanticCycleSnapshotInput,
    type SemanticCycleSnapshotValidationResult
} from './semantic-cycle-contract-types';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVIEW_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compareCanonicalStrings(left: string, right: string): number {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort(compareCanonicalStrings)) {
            result[key] = canonicalize(value[key]);
        }
        return result;
    }
    return value;
}

export function serializeSemanticCycleValue(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function sha256Value(value: unknown): string {
    return stringSha256(serializeSemanticCycleValue(value)) || '';
}

function sortReviewLanes(reviewLanes: readonly SemanticCycleReviewLaneBinding[]): SemanticCycleReviewLaneBinding[] {
    return reviewLanes
        .map((lane) => ({ ...lane }))
        .sort((left, right) => compareCanonicalStrings(left.review_type, right.review_type));
}

export function deriveSemanticCycleReviewBindings(
    reviewLanes: readonly SemanticCycleReviewLaneBinding[]
): Pick<SemanticCycleSnapshot['bindings'], typeof SEMANTIC_CYCLE_REVIEW_BINDING_KEYS[number]> {
    const lanes = sortReviewLanes(reviewLanes);
    return {
        review_contexts: sha256Value(lanes.map((lane) => ({
            review_type: lane.review_type,
            context_sha256: lane.context_sha256
        }))),
        findings_dispositions: sha256Value(lanes.map((lane) => ({
            review_type: lane.review_type,
            findings_disposition_sha256: lane.findings_disposition_sha256
        }))),
        review_receipts: sha256Value(lanes.map((lane) => ({
            review_type: lane.review_type,
            receipt_sha256: lane.receipt_sha256,
            accepted_receipt: lane.accepted_receipt
        }))),
        reviewer_dependencies: sha256Value(lanes.map((lane) => ({
            review_type: lane.review_type,
            dependency_state_sha256: lane.dependency_state_sha256
        })))
    };
}

export function buildSemanticCycleSnapshotHashPayload(
    snapshot: Omit<SemanticCycleSnapshot, 'snapshot_sha256'> | SemanticCycleSnapshot
): Omit<SemanticCycleSnapshot, 'snapshot_sha256'> {
    return {
        schema_version: snapshot.schema_version,
        contract_id: snapshot.contract_id,
        task_id: snapshot.task_id,
        runtime: { ...snapshot.runtime },
        lifecycle_position: { ...snapshot.lifecycle_position },
        bindings: { ...snapshot.bindings },
        review_lanes: snapshot.review_lanes.map((lane) => ({ ...lane }))
    };
}

export function computeSemanticCycleSnapshotSha256(
    snapshot: Omit<SemanticCycleSnapshot, 'snapshot_sha256'> | SemanticCycleSnapshot
): string {
    return sha256Value(buildSemanticCycleSnapshotHashPayload(snapshot));
}

export function buildSemanticCycleSnapshot(input: SemanticCycleSnapshotInput): SemanticCycleSnapshot {
    const reviewLanes = sortReviewLanes(input.review_lanes);
    const snapshotWithoutHash: Omit<SemanticCycleSnapshot, 'snapshot_sha256'> = {
        schema_version: SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION,
        contract_id: SEMANTIC_CYCLE_CONTRACT_ID,
        task_id: input.task_id,
        runtime: { ...input.runtime },
        lifecycle_position: { ...input.lifecycle_position },
        bindings: {
            ...input.bindings,
            ...deriveSemanticCycleReviewBindings(reviewLanes)
        },
        review_lanes: reviewLanes
    };
    const snapshot: SemanticCycleSnapshot = {
        ...snapshotWithoutHash,
        snapshot_sha256: computeSemanticCycleSnapshotSha256(snapshotWithoutHash)
    };
    const validation = validateSemanticCycleSnapshot(snapshot);
    if (validation.status !== 'VALID') {
        throw new Error(`Semantic cycle snapshot input is invalid: ${validation.violations.join(' ')}`);
    }
    return snapshot;
}

function validateExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[],
    label: string,
    violations: string[]
): void {
    const expected = new Set(expectedKeys);
    const missing = expectedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
    const unexpected = Object.keys(value).filter((key) => !expected.has(key));
    if (missing.length > 0) {
        violations.push(`${label} is missing required field(s): ${missing.join(', ')}.`);
    }
    if (unexpected.length > 0) {
        violations.push(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`);
    }
}

function validateSha256(value: unknown, label: string, violations: string[]): void {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        violations.push(`${label} must be a lowercase SHA-256 hex string.`);
    }
}

function validateLifecyclePosition(
    value: unknown,
    label: string,
    violations: string[]
): value is SemanticCycleLifecyclePosition {
    if (!isRecord(value)) {
        violations.push(`${label} must be an object.`);
        return false;
    }
    validateExactKeys(value, ['cycle_sha256', 'task_event_sequence'], label, violations);
    validateSha256(value.cycle_sha256, `${label}.cycle_sha256`, violations);
    if (!Number.isInteger(value.task_event_sequence) || Number(value.task_event_sequence) < 0) {
        violations.push(`${label}.task_event_sequence must be a non-negative integer.`);
    }
    return true;
}

function parseReviewLane(
    value: unknown,
    index: number,
    violations: string[]
): SemanticCycleReviewLaneBinding | null {
    const label = `review_lanes[${index}]`;
    if (!isRecord(value)) {
        violations.push(`${label} must be an object.`);
        return null;
    }
    validateExactKeys(value, [
        'review_type',
        'context_sha256',
        'findings_disposition_sha256',
        'receipt_sha256',
        'dependency_state_sha256',
        'accepted_receipt'
    ], label, violations);
    if (typeof value.review_type !== 'string' || !REVIEW_TYPE_PATTERN.test(value.review_type)) {
        violations.push(`${label}.review_type must be a canonical review lane id.`);
    }
    for (const key of [
        'context_sha256',
        'findings_disposition_sha256',
        'receipt_sha256',
        'dependency_state_sha256'
    ] as const) {
        validateSha256(value[key], `${label}.${key}`, violations);
    }
    if (typeof value.accepted_receipt !== 'boolean') {
        violations.push(`${label}.accepted_receipt must be boolean.`);
    }
    if (violations.some((violation) => violation.startsWith(label))) {
        return null;
    }
    return value as unknown as SemanticCycleReviewLaneBinding;
}

export function validateSemanticCycleSnapshot(value: unknown): SemanticCycleSnapshotValidationResult {
    const violations: string[] = [];
    if (!isRecord(value)) {
        return { status: 'INVALID', snapshot: null, violations: ['snapshot must be an object.'] };
    }
    validateExactKeys(value, [
        'schema_version',
        'contract_id',
        'task_id',
        'runtime',
        'lifecycle_position',
        'bindings',
        'review_lanes',
        'snapshot_sha256'
    ], 'snapshot', violations);
    if (value.schema_version !== SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION) {
        violations.push(`snapshot.schema_version must equal ${SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION}.`);
    }
    if (value.contract_id !== SEMANTIC_CYCLE_CONTRACT_ID) {
        violations.push(`snapshot.contract_id must equal '${SEMANTIC_CYCLE_CONTRACT_ID}'.`);
    }
    if (!isCanonicalTaskId(value.task_id)) {
        violations.push('snapshot.task_id must be canonical.');
    }

    validateLifecyclePosition(value.lifecycle_position, 'snapshot.lifecycle_position', violations);

    if (!isRecord(value.runtime)) {
        violations.push('snapshot.runtime must be an object.');
    } else {
        validateExactKeys(value.runtime, [
            'cli_version',
            'task_event_schema_version',
            'snapshot_schema_version'
        ], 'snapshot.runtime', violations);
        if (typeof value.runtime.cli_version !== 'string' || !value.runtime.cli_version.trim()) {
            violations.push('snapshot.runtime.cli_version must be non-empty.');
        }
        if (!Number.isInteger(value.runtime.task_event_schema_version) || Number(value.runtime.task_event_schema_version) < 1) {
            violations.push('snapshot.runtime.task_event_schema_version must be a positive integer.');
        }
        if (value.runtime.snapshot_schema_version !== SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION) {
            violations.push(
                `snapshot.runtime.snapshot_schema_version must equal ${SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION}.`
            );
        }
    }

    if (!isRecord(value.bindings)) {
        violations.push('snapshot.bindings must be an object.');
    } else {
        validateExactKeys(value.bindings, SEMANTIC_CYCLE_BINDING_KEYS, 'snapshot.bindings', violations);
        for (const key of SEMANTIC_CYCLE_BINDING_KEYS) {
            validateSha256(value.bindings[key], `snapshot.bindings.${key}`, violations);
        }
    }

    const reviewLanes: SemanticCycleReviewLaneBinding[] = [];
    if (!Array.isArray(value.review_lanes)) {
        violations.push('snapshot.review_lanes must be an array.');
    } else {
        value.review_lanes.forEach((lane, index) => {
            const parsed = parseReviewLane(lane, index, violations);
            if (parsed) {
                reviewLanes.push(parsed);
            }
        });
        const laneIds = reviewLanes.map((lane) => lane.review_type);
        if (new Set(laneIds).size !== laneIds.length) {
            violations.push('snapshot.review_lanes must not contain duplicate review_type values.');
        }
        const sortedIds = [...laneIds].sort(compareCanonicalStrings);
        if (laneIds.some((laneId, index) => laneId !== sortedIds[index])) {
            violations.push('snapshot.review_lanes must be sorted by review_type.');
        }
        if (isRecord(value.bindings)) {
            const derived = deriveSemanticCycleReviewBindings(reviewLanes);
            for (const key of SEMANTIC_CYCLE_REVIEW_BINDING_KEYS) {
                if (value.bindings[key] !== derived[key]) {
                    violations.push(`snapshot.bindings.${key} does not match review_lanes.`);
                }
            }
        }
    }
    validateSha256(value.snapshot_sha256, 'snapshot.snapshot_sha256', violations);
    if (violations.length === 0) {
        const snapshot = value as unknown as SemanticCycleSnapshot;
        if (snapshot.snapshot_sha256 !== computeSemanticCycleSnapshotSha256(snapshot)) {
            violations.push('snapshot.snapshot_sha256 does not authenticate the snapshot payload.');
        }
    }
    return violations.length > 0
        ? { status: 'INVALID', snapshot: null, violations }
        : { status: 'VALID', snapshot: value as unknown as SemanticCycleSnapshot, violations: [] };
}

export function copySemanticCycleBaseBindings(
    bindings: SemanticCycleSnapshot['bindings']
): SemanticCycleSnapshotInput['bindings'] {
    return Object.fromEntries(
        SEMANTIC_CYCLE_BASE_BINDING_KEYS.map((key) => [key, bindings[key]])
    ) as Record<typeof SEMANTIC_CYCLE_BASE_BINDING_KEYS[number], string>;
}

export function isSemanticCycleBindingKey(value: string): value is SemanticCycleBindingKey {
    return (SEMANTIC_CYCLE_BINDING_KEYS as readonly string[]).includes(value);
}
