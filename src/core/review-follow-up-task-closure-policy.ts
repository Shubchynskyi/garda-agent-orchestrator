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
                'Task metadata has no explicit review follow-up provenance; closure controls are inapplicable and disabled.'
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

export function resolveReviewFollowUpTaskClosurePolicy(
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
                'Task metadata has no explicit review follow-up provenance; closure controls are inapplicable and disabled.'
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
                'Explicit review follow-up provenance found; closure controls default off because policy metadata is absent.'
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
                'Review follow-up task closure policy must be exact schema-1 JSON with two boolean settings; settings fail closed.'
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

export function buildLegacyReviewFollowUpTaskClosurePolicySnapshot(): ReviewFollowUpTaskClosurePolicySnapshot {
    return defaultSnapshot({
        notes: '',
        eligible: false,
        configured: false,
        valid: true,
        provenance: null,
        diagnostics: [
            'Legacy profile policy snapshot has no task-level follow-up closure policy; settings default off.'
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
