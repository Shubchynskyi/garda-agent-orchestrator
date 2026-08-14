import { stringSha256 } from '../../gate-runtime/hash';
import {
    SEMANTIC_CYCLE_BINDING_KEYS,
    SEMANTIC_CYCLE_BINDING_MISMATCH_CODES,
    SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION,
    type SemanticCycleComparisonResult,
    type SemanticCycleMismatch,
    type SemanticCycleReviewLaneBinding,
    type SemanticCycleRuntimeCompatibilityResult,
    type SemanticCycleRuntimeIdentity,
    type SemanticCycleSnapshot
} from './semantic-cycle-contract-types';
import {
    serializeSemanticCycleValue,
    validateSemanticCycleSnapshot
} from './semantic-cycle-snapshot';

function mismatch(
    code: SemanticCycleMismatch['code'],
    artifact: string,
    expected: SemanticCycleMismatch['expected'],
    actual: SemanticCycleMismatch['actual'],
    message: string
): SemanticCycleMismatch {
    return { code, artifact, expected, actual, message };
}

export function assessSemanticCycleRuntimeCompatibility(
    snapshot: SemanticCycleSnapshot,
    currentRuntime: SemanticCycleRuntimeIdentity
): SemanticCycleRuntimeCompatibilityResult {
    const mismatches: SemanticCycleMismatch[] = [];
    if (
        currentRuntime.snapshot_schema_version !== SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION
        || snapshot.runtime.snapshot_schema_version !== currentRuntime.snapshot_schema_version
    ) {
        mismatches.push(mismatch(
            'SNAPSHOT_SCHEMA_UNSUPPORTED',
            'runtime.snapshot_schema_version',
            snapshot.runtime.snapshot_schema_version,
            currentRuntime.snapshot_schema_version,
            'The active runtime cannot interpret the authenticated semantic-cycle snapshot schema.'
        ));
    }
    if (snapshot.runtime.cli_version !== currentRuntime.cli_version) {
        mismatches.push(mismatch(
            'RUNTIME_CLI_MISMATCH',
            'runtime.cli_version',
            snapshot.runtime.cli_version,
            currentRuntime.cli_version,
            'The active CLI version differs from the version that produced the authenticated snapshot.'
        ));
    }
    if (snapshot.runtime.task_event_schema_version !== currentRuntime.task_event_schema_version) {
        mismatches.push(mismatch(
            'TASK_EVENT_SCHEMA_MISMATCH',
            'runtime.task_event_schema_version',
            snapshot.runtime.task_event_schema_version,
            currentRuntime.task_event_schema_version,
            'The active runtime would write a different task-event schema.'
        ));
    }
    return mismatches.length === 0
        ? { status: 'COMPATIBLE', mutation_allowed: true, mismatches: [], remediation: null }
        : {
            status: 'INCOMPATIBLE',
            mutation_allowed: false,
            mismatches,
            remediation:
                'Run the current workspace CLI/runtime that matches the authenticated snapshot before appending lifecycle evidence.'
        };
}

export class SemanticCycleRuntimeCompatibilityError extends Error {
    readonly code = 'SEMANTIC_CYCLE_RUNTIME_INCOMPATIBLE';

    constructor(readonly compatibility: SemanticCycleRuntimeCompatibilityResult) {
        super(compatibility.remediation || 'Semantic-cycle runtime compatibility check failed.');
        this.name = 'SemanticCycleRuntimeCompatibilityError';
    }
}

export function assertSemanticCycleRuntimeCompatibility(
    snapshot: SemanticCycleSnapshot,
    currentRuntime: SemanticCycleRuntimeIdentity
): void {
    const compatibility = assessSemanticCycleRuntimeCompatibility(snapshot, currentRuntime);
    if (!compatibility.mutation_allowed) {
        throw new SemanticCycleRuntimeCompatibilityError(compatibility);
    }
}

function compareReviewLanes(
    authoritative: readonly SemanticCycleReviewLaneBinding[],
    candidate: readonly SemanticCycleReviewLaneBinding[]
): SemanticCycleMismatch[] {
    const mismatches: SemanticCycleMismatch[] = [];
    const authoritativeByLane = new Map(authoritative.map((lane) => [lane.review_type, lane]));
    const candidateByLane = new Map(candidate.map((lane) => [lane.review_type, lane]));
    const authoritativeIds = [...authoritativeByLane.keys()].sort();
    const candidateIds = [...candidateByLane.keys()].sort();
    if (authoritativeIds.join('\n') !== candidateIds.join('\n')) {
        mismatches.push(mismatch(
            'REVIEW_LANE_SET_MISMATCH',
            'review_lanes',
            authoritativeIds.join(','),
            candidateIds.join(','),
            'The effective review lane set changed.'
        ));
    }
    for (const reviewType of authoritativeIds) {
        const expected = authoritativeByLane.get(reviewType);
        const actual = candidateByLane.get(reviewType);
        if (!expected || !actual) {
            continue;
        }
        const comparisons = [
            ['context_sha256', 'REVIEW_LANE_CONTEXT_MISMATCH', 'review context'],
            ['findings_disposition_sha256', 'REVIEW_LANE_FINDINGS_MISMATCH', 'findings disposition'],
            ['receipt_sha256', 'REVIEW_LANE_RECEIPT_MISMATCH', 'review receipt'],
            ['dependency_state_sha256', 'REVIEW_LANE_DEPENDENCY_MISMATCH', 'review dependency state'],
            ['accepted_receipt', 'REVIEW_LANE_ACCEPTANCE_MISMATCH', 'accepted-receipt state']
        ] as const;
        for (const [field, code, label] of comparisons) {
            if (expected[field] !== actual[field]) {
                mismatches.push(mismatch(
                    code,
                    `review_lanes.${reviewType}.${field}`,
                    expected[field],
                    actual[field],
                    `The ${label} changed for review lane '${reviewType}'.`
                ));
            }
        }
    }
    return mismatches;
}

function buildComparisonResult(
    status: SemanticCycleComparisonResult['status'],
    authoritative: SemanticCycleSnapshot | null,
    candidate: SemanticCycleSnapshot | null,
    mismatches: SemanticCycleMismatch[]
): SemanticCycleComparisonResult {
    const mutationAllowed = status === 'REUSABLE' && mismatches.length === 0;
    const base = {
        schema_version: 1 as const,
        status,
        task_id: authoritative?.task_id || candidate?.task_id || null,
        authoritative_snapshot_sha256: authoritative?.snapshot_sha256 || null,
        candidate_snapshot_sha256: candidate?.snapshot_sha256 || null,
        mutation_allowed: mutationAllowed,
        route: mutationAllowed
            ? 'semantic_rebind' as const
            : status === 'RUNTIME_INCOMPATIBLE'
                ? 'runtime_upgrade_required' as const
                : 'existing_recovery' as const,
        mismatches
    };
    return {
        ...base,
        decision_sha256: stringSha256(serializeSemanticCycleValue(base)) || ''
    };
}

export function compareSemanticCycleSnapshots(
    authoritativeValue: unknown,
    candidateValue: unknown,
    currentRuntime: SemanticCycleRuntimeIdentity
): SemanticCycleComparisonResult {
    const authoritativeValidation = validateSemanticCycleSnapshot(authoritativeValue);
    const candidateValidation = validateSemanticCycleSnapshot(candidateValue);
    const validationMismatches: SemanticCycleMismatch[] = [];
    if (!authoritativeValidation.snapshot) {
        validationMismatches.push(mismatch(
            'AUTHORITATIVE_SNAPSHOT_INVALID',
            'authoritative_snapshot',
            'valid authenticated snapshot',
            authoritativeValidation.violations.join(' '),
            'The authoritative semantic-cycle snapshot failed validation.'
        ));
    }
    if (!candidateValidation.snapshot) {
        validationMismatches.push(mismatch(
            'CANDIDATE_SNAPSHOT_INVALID',
            'candidate_snapshot',
            'valid authenticated snapshot',
            candidateValidation.violations.join(' '),
            'The candidate semantic-cycle snapshot failed validation.'
        ));
    }
    if (!authoritativeValidation.snapshot || !candidateValidation.snapshot) {
        return buildComparisonResult(
            'RECOVERY_REQUIRED',
            authoritativeValidation.snapshot,
            candidateValidation.snapshot,
            validationMismatches
        );
    }

    const authoritative = authoritativeValidation.snapshot;
    const candidate = candidateValidation.snapshot;
    const runtimeMismatches = [
        ...assessSemanticCycleRuntimeCompatibility(authoritative, currentRuntime).mismatches
    ];
    for (const entry of assessSemanticCycleRuntimeCompatibility(candidate, currentRuntime).mismatches) {
        if (!runtimeMismatchesContain(runtimeMismatches, entry)) {
            runtimeMismatches.push(entry);
        }
    }
    if (runtimeMismatches.length > 0) {
        return buildComparisonResult('RUNTIME_INCOMPATIBLE', authoritative, candidate, runtimeMismatches);
    }

    const mismatches: SemanticCycleMismatch[] = [];
    if (authoritative.task_id !== candidate.task_id) {
        mismatches.push(mismatch(
            'TASK_ID_MISMATCH',
            'task_id',
            authoritative.task_id,
            candidate.task_id,
            'The candidate snapshot belongs to a different task.'
        ));
    }
    for (const key of SEMANTIC_CYCLE_BINDING_KEYS) {
        if (authoritative.bindings[key] !== candidate.bindings[key]) {
            mismatches.push(mismatch(
                SEMANTIC_CYCLE_BINDING_MISMATCH_CODES[key],
                `bindings.${key}`,
                authoritative.bindings[key],
                candidate.bindings[key],
                `The authenticated '${key}' semantic binding changed.`
            ));
        }
    }
    mismatches.push(...compareReviewLanes(authoritative.review_lanes, candidate.review_lanes));
    return buildComparisonResult(
        mismatches.length === 0 ? 'REUSABLE' : 'RECOVERY_REQUIRED',
        authoritative,
        candidate,
        mismatches
    );
}

function runtimeMismatchesContain(
    existing: readonly SemanticCycleMismatch[],
    candidate: SemanticCycleMismatch
): boolean {
    return existing.some((entry) => entry.code === candidate.code && entry.artifact === candidate.artifact);
}
