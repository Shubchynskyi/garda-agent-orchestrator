import { createHash } from 'node:crypto';

export const REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION = 1 as const;
export const REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_METADATA_KEY =
    'review_follow_up_task_closure_policy' as const;

export type ReviewFollowUpTaskProvenance = 'per_finding' | 'grouped_by_parent';

export interface ReviewFollowUpTaskClosurePolicySnapshot {
    schema_version: typeof REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION;
    eligible: boolean;
    configured: boolean;
    valid: boolean;
    provenance: ReviewFollowUpTaskProvenance | null;
    source_notes_sha256: string | null;
    skip_low_findings: boolean;
    forbid_child_tasks: boolean;
    diagnostics: string[];
}

export interface ReviewFollowUpTaskClosurePolicyValue {
    skip_low_findings: boolean;
    forbid_child_tasks: boolean;
}

export interface ReviewFollowUpTaskClosurePolicyTaskContext {
    taskId: string;
    taskRows: readonly {
        taskId: string;
        notes: string | null;
    }[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const POLICY_VALUE_KEYS = [
    'schema_version',
    'skip_low_findings',
    'forbid_child_tasks'
] as const;
const SORTED_POLICY_VALUE_KEYS = [...POLICY_VALUE_KEYS].sort();
const SNAPSHOT_KEYS = [
    'schema_version',
    'eligible',
    'configured',
    'valid',
    'provenance',
    'source_notes_sha256',
    'skip_low_findings',
    'forbid_child_tasks',
    'diagnostics'
] as const;
const METADATA_TOKEN_LEFT_BOUNDARY = '(?:^|\\s)';
const POLICY_METADATA_TOKEN_PATTERN = new RegExp(
    `${METADATA_TOKEN_LEFT_BOUNDARY}${REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_METADATA_KEY}=`,
    'gu'
);
const POLICY_METADATA_PATTERN = new RegExp(
    `${METADATA_TOKEN_LEFT_BOUNDARY}${REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_METADATA_KEY}=\`([^\`\\r\\n]*)\`\\.(?=$|\\s)`,
    'gu'
);
const PER_FINDING_PROVENANCE_TOKEN_PATTERN = /(?:^|\s)review_follow_up_fingerprint=/gu;
const PER_FINDING_PROVENANCE_PATTERN = /(?:^|\s)review_follow_up_fingerprint=([a-f0-9]{64})\.(?=$|\s)/gu;
const GROUPED_PROVENANCE_TOKEN_PATTERN = /(?:^|\s)review_follow_up_group_fingerprint=/gu;
const GROUPED_PROVENANCE_PATTERN = /(?:^|\s)review_follow_up_group_fingerprint=([a-f0-9]{64})\.(?=$|\s)/gu;
const MAX_POLICY_METADATA_CHARS = 256;
const REVIEW_FOLLOW_UP_METADATA_MARKER = 'review_follow_up_';

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultSnapshot(params: {
    notes: string;
    hashSourceNotes?: boolean;
    eligible: boolean;
    configured: boolean;
    valid: boolean;
    provenance: ReviewFollowUpTaskProvenance | null;
    diagnostics: string[];
}): ReviewFollowUpTaskClosurePolicySnapshot {
    return {
        schema_version: REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION,
        eligible: params.eligible,
        configured: params.configured,
        valid: params.valid,
        provenance: params.provenance,
        source_notes_sha256: params.hashSourceNotes !== false && params.notes
            ? sha256Text(params.notes)
            : null,
        skip_low_findings: false,
        forbid_child_tasks: false,
        diagnostics: [...params.diagnostics]
    };
}

function resolveProvenance(notes: string): {
    eligible: boolean;
    valid: boolean;
    provenance: ReviewFollowUpTaskProvenance | null;
    diagnostics: string[];
} {
    const perFindingMarkers = [...notes.matchAll(PER_FINDING_PROVENANCE_PATTERN)];
    const groupedMarkers = [...notes.matchAll(GROUPED_PROVENANCE_PATTERN)];
    const perFindingTokenCount = [...notes.matchAll(PER_FINDING_PROVENANCE_TOKEN_PATTERN)].length;
    const groupedTokenCount = [...notes.matchAll(GROUPED_PROVENANCE_TOKEN_PATTERN)].length;
    const provenanceTokenCount = perFindingTokenCount + groupedTokenCount;

    if (provenanceTokenCount === 0) {
        return {
            eligible: false,
            valid: true,
            provenance: null,
            diagnostics: [
                'Closure controls apply only to review-generated follow-up tasks with explicit provenance; this task is not editable.'
            ]
        };
    }
    if (
        provenanceTokenCount !== 1
        || perFindingMarkers.length + groupedMarkers.length !== 1
        || perFindingMarkers.length !== perFindingTokenCount
        || groupedMarkers.length !== groupedTokenCount
    ) {
        return {
            eligible: false,
            valid: false,
            provenance: null,
            diagnostics: [
                'Review follow-up provenance metadata is malformed, duplicated, or ambiguous; closure controls fail closed.'
            ]
        };
    }
    return {
        eligible: true,
        valid: true,
        provenance: perFindingMarkers.length === 1 ? 'per_finding' : 'grouped_by_parent',
        diagnostics: []
    };
}

function parsePolicyValue(rawValue: string): ReviewFollowUpTaskClosurePolicyValue | null {
    if (rawValue.length > MAX_POLICY_METADATA_CHARS || rawValue.includes('\\')) {
        return null;
    }
    if (POLICY_VALUE_KEYS.some((key) => (
        [...rawValue.matchAll(new RegExp(`"${key}"\\s*:`, 'gu'))].length !== 1
    ))) {
        return null;
    }
    try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (!isPlainRecord(parsed)) {
            return null;
        }
        const keys = Object.keys(parsed).sort();
        if (
            keys.length !== POLICY_VALUE_KEYS.length
            || keys.some((key, index) => key !== SORTED_POLICY_VALUE_KEYS[index])
            || parsed.schema_version !== REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION
            || typeof parsed.skip_low_findings !== 'boolean'
            || typeof parsed.forbid_child_tasks !== 'boolean'
        ) {
            return null;
        }
        return {
            skip_low_findings: parsed.skip_low_findings,
            forbid_child_tasks: parsed.forbid_child_tasks
        };
    } catch {
        return null;
    }
}

function resolveReviewFollowUpTaskClosurePolicyFromNotes(
    taskNotes: unknown
): ReviewFollowUpTaskClosurePolicySnapshot {
    const notes = typeof taskNotes === 'string' ? taskNotes.trim() : '';
    if (!notes.includes(REVIEW_FOLLOW_UP_METADATA_MARKER)) {
        return defaultSnapshot({
            notes,
            hashSourceNotes: false,
            eligible: false,
            configured: false,
            valid: true,
            provenance: null,
            diagnostics: [
                'Closure controls apply only to review-generated follow-up tasks with explicit provenance; this task is not editable.'
            ]
        });
    }
    const provenance = resolveProvenance(notes);
    const policyTokens = [...notes.matchAll(POLICY_METADATA_PATTERN)];
    const policyTokenCount = [...notes.matchAll(POLICY_METADATA_TOKEN_PATTERN)].length;
    const configured = policyTokenCount > 0;

    if (!provenance.valid) {
        return defaultSnapshot({
            notes,
            eligible: false,
            configured,
            valid: false,
            provenance: null,
            diagnostics: provenance.diagnostics
        });
    }
    if (!provenance.eligible) {
        return defaultSnapshot({
            notes,
            eligible: false,
            configured,
            valid: !configured,
            provenance: null,
            diagnostics: configured
                ? [
                    ...provenance.diagnostics,
                    'Closure policy metadata is present without explicit review follow-up provenance; settings fail closed.'
                ]
                : provenance.diagnostics
        });
    }
    if (!configured) {
        return defaultSnapshot({
            notes,
            eligible: true,
            configured: false,
            valid: true,
            provenance: provenance.provenance,
            diagnostics: [
                'Explicit review follow-up provenance found, but closure controls are unconfigured; the strict F-task safety floor remains active until explicit policy metadata is frozen.'
            ]
        });
    }
    if (policyTokenCount !== 1 || policyTokens.length !== 1) {
        return defaultSnapshot({
            notes,
            eligible: true,
            configured: true,
            valid: false,
            provenance: provenance.provenance,
            diagnostics: [
                'Review follow-up task closure policy metadata is malformed or duplicated; settings fail closed.'
            ]
        });
    }
    const policy = parsePolicyValue(policyTokens[0][1]);
    if (!policy) {
        return defaultSnapshot({
            notes,
            eligible: true,
            configured: true,
            valid: false,
            provenance: provenance.provenance,
            diagnostics: [
                'Review follow-up task closure policy is invalid: exact schema-1 JSON is required and both settings must be boolean; settings fail closed.'
            ]
        });
    }
    return {
        schema_version: REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION,
        eligible: true,
        configured: true,
        valid: true,
        provenance: provenance.provenance,
        source_notes_sha256: notes ? sha256Text(notes) : null,
        ...policy,
        diagnostics: [
            `Review follow-up task closure policy resolved from explicit ${provenance.provenance} task metadata.`
        ]
    };
}

function resolveBoundParentTaskId(taskId: string): string | null {
    const match = String(taskId || '').match(/^(.+)-F[1-9][0-9]*$/u);
    return match?.[1] || null;
}

function hasCanonicalChildOfBinding(notes: string, parentTaskId: string): boolean {
    const bindings = [...notes.matchAll(/(?:^|\s)Child of `([^`\r\n]+)`\.(?=$|\s)/gu)];
    return bindings.length === 1 && bindings[0][1] === parentTaskId;
}

function parentMaterializationReferencesTask(notes: string, taskId: string): boolean {
    let referenceCount = 0;
    const records = notes.matchAll(
        /(?:^|\s)Review follow-up tasks materialized: (`[^`\r\n]+`(?:, `[^`\r\n]+`)*); artifact `[^`\r\n]+`\.(?=$|\s)/gu
    );
    for (const record of records) {
        const taskIds = [...record[1].matchAll(/`([^`\r\n]+)`/gu)].map((match) => match[1]);
        referenceCount += taskIds.filter((candidate) => candidate === taskId).length;
    }
    return referenceCount === 1;
}

function bindPolicyToCanonicalTask(
    snapshot: ReviewFollowUpTaskClosurePolicySnapshot,
    notes: string,
    context: ReviewFollowUpTaskClosurePolicyTaskContext | undefined
): ReviewFollowUpTaskClosurePolicySnapshot {
    if (!snapshot.eligible || !snapshot.valid) {
        return snapshot;
    }
    const parentTaskId = context ? resolveBoundParentTaskId(context.taskId) : null;
    const parentRows = parentTaskId
        ? context?.taskRows.filter((row) => row.taskId === parentTaskId) || []
        : [];
    const bindingValid = Boolean(
        context
        && parentTaskId
        && hasCanonicalChildOfBinding(notes, parentTaskId)
        && parentRows.length === 1
        && parentMaterializationReferencesTask(String(parentRows[0].notes || ''), context.taskId)
    );
    if (bindingValid) {
        return snapshot;
    }
    return {
        ...snapshot,
        eligible: false,
        valid: false,
        provenance: null,
        skip_low_findings: false,
        forbid_child_tasks: false,
        diagnostics: [
            'Review follow-up provenance is not bound to one canonical parent materialization record; closure controls fail closed.'
        ]
    };
}

export function resolveReviewFollowUpTaskClosurePolicy(
    taskNotes: unknown,
    context?: ReviewFollowUpTaskClosurePolicyTaskContext
): ReviewFollowUpTaskClosurePolicySnapshot {
    const notes = typeof taskNotes === 'string' ? taskNotes.trim() : '';
    return bindPolicyToCanonicalTask(
        resolveReviewFollowUpTaskClosurePolicyFromNotes(notes),
        notes,
        context
    );
}

export function buildLegacyReviewFollowUpTaskClosurePolicySnapshot(): ReviewFollowUpTaskClosurePolicySnapshot {
    return defaultSnapshot({
        notes: '',
        eligible: false,
        configured: false,
        valid: true,
        provenance: null,
        diagnostics: [
            'Legacy profile policy snapshot has no task-level follow-up closure policy; the strict F-task safety floor remains active.'
        ]
    });
}

export function formatReviewFollowUpTaskClosurePolicyMetadata(
    value: ReviewFollowUpTaskClosurePolicyValue
): string {
    return `${REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_METADATA_KEY}=\`${JSON.stringify({
        schema_version: REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION,
        skip_low_findings: value.skip_low_findings,
        forbid_child_tasks: value.forbid_child_tasks
    })}\`.`;
}

export function replaceReviewFollowUpTaskClosurePolicyMetadata(
    taskNotes: string,
    value: ReviewFollowUpTaskClosurePolicyValue,
    context?: ReviewFollowUpTaskClosurePolicyTaskContext
): string {
    const notes = String(taskNotes || '').trim();
    const current = resolveReviewFollowUpTaskClosurePolicy(notes, context);
    if (!current.eligible || !current.valid) {
        throw new Error(
            current.diagnostics.join(' ')
            || 'Review follow-up task closure policy metadata is not editable.'
        );
    }
    const withoutCurrentPolicy = current.configured
        ? notes.replace(POLICY_METADATA_PATTERN, ' ').replace(/\s+/gu, ' ').trim()
        : notes;
    return [
        withoutCurrentPolicy,
        formatReviewFollowUpTaskClosurePolicyMetadata(value)
    ].filter(Boolean).join(' ');
}

export function getReviewFollowUpTaskClosurePolicySnapshotViolations(value: unknown): string[] {
    if (!isPlainRecord(value)) {
        return ['review_follow_up_task_closure_policy must be a JSON object.'];
    }
    const violations: string[] = [];
    for (const key of SNAPSHOT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            violations.push(`review_follow_up_task_closure_policy.${key} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!(SNAPSHOT_KEYS as readonly string[]).includes(key)) {
            violations.push(`review_follow_up_task_closure_policy.${key} is not allowed by schema version 1.`);
        }
    }
    if (value.schema_version !== REVIEW_FOLLOW_UP_TASK_CLOSURE_POLICY_SCHEMA_VERSION) {
        violations.push('review_follow_up_task_closure_policy.schema_version must be 1.');
    }
    for (const key of ['eligible', 'configured', 'valid', 'skip_low_findings', 'forbid_child_tasks'] as const) {
        if (typeof value[key] !== 'boolean') {
            violations.push(`review_follow_up_task_closure_policy.${key} must be boolean.`);
        }
    }
    if (value.provenance !== null && value.provenance !== 'per_finding' && value.provenance !== 'grouped_by_parent') {
        violations.push('review_follow_up_task_closure_policy.provenance must be per_finding, grouped_by_parent, or null.');
    }
    if (value.source_notes_sha256 !== null && !SHA256_PATTERN.test(String(value.source_notes_sha256 || ''))) {
        violations.push('review_follow_up_task_closure_policy.source_notes_sha256 must be a SHA-256 hex string or null.');
    }
    if (!Array.isArray(value.diagnostics) || value.diagnostics.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        violations.push('review_follow_up_task_closure_policy.diagnostics must contain non-empty strings.');
    }
    if (value.eligible === true && value.provenance == null) {
        violations.push('review_follow_up_task_closure_policy eligible state requires explicit provenance.');
    }
    if (value.eligible === false && value.provenance != null) {
        violations.push('review_follow_up_task_closure_policy ineligible state must not declare provenance.');
    }
    if (
        (value.eligible !== true || value.configured !== true || value.valid !== true)
        && (value.skip_low_findings === true || value.forbid_child_tasks === true)
    ) {
        violations.push(
            'review_follow_up_task_closure_policy settings may be enabled only for eligible, configured, valid metadata.'
        );
    }
    return violations;
}
