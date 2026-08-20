import { sha256RedactedJsonPayload } from '../core/redaction';
import { isPlainRecord } from '../core/records';
import { normalizePath } from '../gates/shared/helpers';
import type { ReviewRemediationDeltaCategory } from './review-remediation-rerun-policy';

export const REVIEW_REMEDIATION_DELTA_ELIGIBLE_REVIEW_TYPES = Object.freeze([
    'code',
    'refactor',
    'test'
] as const);

export const REVIEW_REMEDIATION_FORCE_FULL_CATEGORIES = Object.freeze([
    'ambiguous',
    'generated_churn',
    'global'
] as const);

export const REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS = Object.freeze([
    'api_contract',
    'auth_or_permission',
    'database',
    'dependency',
    'infrastructure',
    'lockfile',
    'protected_control_plane',
    'schema_or_migration',
    'secret',
    'security',
    'task_criteria_or_policy'
] as const);

export type ReviewRemediationProtectedBoundarySignal =
    typeof REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS[number];

export interface ReviewRemediationModePolicy {
    schema_version: 1;
    policy_id: 'conservative_review_remediation_mode_v1';
    initial_review_mode: 'FULL';
    delta_eligible_review_types: string[];
    force_full_categories: ReviewRemediationDeltaCategory[];
    max_delta_changed_files: number;
    max_delta_changed_lines: number;
    max_consecutive_delta_reviews: number;
}

export interface ReviewRemediationModePolicyResolution {
    policy: ReviewRemediationModePolicy;
    diagnostics: string[];
    legacy_fallback: boolean;
}

export interface ReviewRemediationModeAssessment {
    policy_id: ReviewRemediationModePolicy['policy_id'];
    policy_sha256: string;
    legacy_fallback: boolean;
    mode: 'FULL' | 'DELTA';
    delta_chain_depth: number;
    protected_boundary_signals: ReviewRemediationProtectedBoundarySignal[];
    delta_eligible_review_types: string[];
    full_review_reasons: string[];
    assessment_sha256: string;
}

const POLICY_KEYS = [
    'schema_version',
    'policy_id',
    'initial_review_mode',
    'delta_eligible_review_types',
    'force_full_categories',
    'max_delta_changed_files',
    'max_delta_changed_lines',
    'max_consecutive_delta_reviews'
] as const;

const MAX_DELTA_CHANGED_FILES_SAFETY_CEILING = 5;
const MAX_DELTA_CHANGED_LINES_SAFETY_CEILING = 400;
const MAX_CONSECUTIVE_DELTA_REVIEWS_SAFETY_CEILING = 3;

const DEFAULT_POLICY: ReviewRemediationModePolicy = {
    schema_version: 1,
    policy_id: 'conservative_review_remediation_mode_v1',
    initial_review_mode: 'FULL',
    delta_eligible_review_types: [...REVIEW_REMEDIATION_DELTA_ELIGIBLE_REVIEW_TYPES],
    force_full_categories: [...REVIEW_REMEDIATION_FORCE_FULL_CATEGORIES],
    max_delta_changed_files: 4,
    max_delta_changed_lines: 240,
    max_consecutive_delta_reviews: 3
};

const LEGACY_FALLBACK_DIAGNOSTIC =
    'Legacy task profile policy snapshot missing review_remediation_mode_policy; resolved fail-closed to FULL-only remediation.';

const DENY_ONLY_PATH_SIGNALS: ReadonlyArray<{
    signal: ReviewRemediationProtectedBoundarySignal;
    pattern: RegExp;
}> = [
    { signal: 'lockfile', pattern: /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|cargo\.lock)$/iu },
    { signal: 'auth_or_permission', pattern: /(?:^|\/)(?:auth(?:entication|orization)?|permissions?|rbac|acl|access-control)(?:[./_-]|$)/iu },
    { signal: 'schema_or_migration', pattern: /(?:^|\/)(?:schemas?|migrations?)(?:\/|$)|(?:^|[._/-])migration(?:[._/-]|$)/iu },
    { signal: 'api_contract', pattern: /(?:^|[._/-])(?:openapi|swagger|contracts?|api|routes?|controllers?|endpoints?|graphql|grpc)(?:[._/-]|$)/iu },
    { signal: 'database', pattern: /(?:^|[._/-])(?:db|databases?|persistence|repositories?|dao)(?:[._/-]|$)/iu },
    { signal: 'dependency', pattern: /(?:^|[._/-])(?:dependencies?|vendors?|third[-_]?party)(?:[._/-]|$)|(?:^|\/)package\.json$/iu },
    { signal: 'secret', pattern: /(?:^|\/)(?:\.env(?:\.|$)|secrets?|credentials?)(?:[./_-]|$)/iu },
    { signal: 'security', pattern: /(?:^|[._/-])(?:security|crypto(?:graphy)?|encryption|signing|certificates?|tls)(?:[._/-]|$)/iu },
    { signal: 'infrastructure', pattern: /(?:^|\/)(?:\.github\/workflows|k8s|kubernetes|terraform|helm|docker)(?:\/|[._-]|$)/iu },
    { signal: 'task_criteria_or_policy', pattern: /(?:^|\/)(?:TASK\.md|profiles\.json|paths\.json|review-capabilities\.json|workflow-config\.json)$/iu }
];

const REVIEW_POLICY_SOURCE_PATH_PATTERNS: readonly RegExp[] = [
    /(?:^|\/)src\/policy(?:\/|$)/iu,
    /(?:^|\/)src\/core\/review-(?:catalog|dependency-graph|execution-policy)\.ts$/iu,
    /(?:^|\/)garda-agent-orchestrator\/live\/config\/(?:profiles|paths|review-capabilities|workflow-config)\.json$/iu
];

function clonePolicy(policy: ReviewRemediationModePolicy): ReviewRemediationModePolicy {
    return {
        ...policy,
        delta_eligible_review_types: [...policy.delta_eligible_review_types],
        force_full_categories: [...policy.force_full_categories]
    };
}

function normalizedStringList(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        return null;
    }
    const normalized = [...new Set(value.map((entry) => entry.trim().toLowerCase()).filter(Boolean))].sort();
    return JSON.stringify(normalized) === JSON.stringify(value) ? normalized : null;
}

function canonicalStringList(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        return null;
    }
    const canonical = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].sort();
    return JSON.stringify(canonical) === JSON.stringify(value) ? canonical : null;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function buildDefaultReviewRemediationModePolicy(): ReviewRemediationModePolicy {
    return clonePolicy(DEFAULT_POLICY);
}

export function hasReviewRemediationPolicySourceChange(changedFiles: readonly string[]): boolean {
    return changedFiles.some((rawPath) => {
        const filePath = normalizePath(rawPath);
        return REVIEW_POLICY_SOURCE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
    });
}

export function getReviewRemediationModePolicyViolations(value: unknown): string[] {
    if (!isPlainRecord(value)) {
        return ['review_remediation_mode_policy must be a JSON object.'];
    }
    const violations: string[] = [];
    for (const key of POLICY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            violations.push(`review_remediation_mode_policy.${key} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!(POLICY_KEYS as readonly string[]).includes(key)) {
            violations.push(`review_remediation_mode_policy.${key} is not allowed.`);
        }
    }
    if (value.schema_version !== 1) {
        violations.push('review_remediation_mode_policy.schema_version must be 1.');
    }
    if (value.policy_id !== 'conservative_review_remediation_mode_v1') {
        violations.push(
            'review_remediation_mode_policy.policy_id must be "conservative_review_remediation_mode_v1".'
        );
    }
    if (value.initial_review_mode !== 'FULL') {
        violations.push('review_remediation_mode_policy.initial_review_mode must be FULL.');
    }
    const eligibleReviewTypes = normalizedStringList(value.delta_eligible_review_types);
    if (!eligibleReviewTypes || eligibleReviewTypes.length === 0) {
        violations.push(
            'review_remediation_mode_policy.delta_eligible_review_types must be a canonical non-empty array.'
        );
    } else {
        const weakened = eligibleReviewTypes.filter((reviewType) => (
            !(REVIEW_REMEDIATION_DELTA_ELIGIBLE_REVIEW_TYPES as readonly string[]).includes(reviewType)
        ));
        if (weakened.length > 0) {
            violations.push(
                `review_remediation_mode_policy.delta_eligible_review_types cannot weaken the protected lane floor: ${weakened.join(', ')}.`
            );
        }
    }
    const forceFullCategories = normalizedStringList(value.force_full_categories);
    if (!forceFullCategories) {
        violations.push(
            'review_remediation_mode_policy.force_full_categories must be a canonical array.'
        );
    } else {
        const missing = REVIEW_REMEDIATION_FORCE_FULL_CATEGORIES.filter((category) => (
            !forceFullCategories.includes(category)
        ));
        if (missing.length > 0) {
            violations.push(
                `review_remediation_mode_policy.force_full_categories cannot omit mandatory floors: ${missing.join(', ')}.`
            );
        }
    }
    for (const [key, safetyCeiling] of [
        ['max_delta_changed_files', MAX_DELTA_CHANGED_FILES_SAFETY_CEILING],
        ['max_delta_changed_lines', MAX_DELTA_CHANGED_LINES_SAFETY_CEILING],
        ['max_consecutive_delta_reviews', MAX_CONSECUTIVE_DELTA_REVIEWS_SAFETY_CEILING]
    ] as const) {
        const candidate = value[key];
        if (!isPositiveInteger(candidate)) {
            violations.push(`review_remediation_mode_policy.${key} must be a positive integer.`);
        } else if (candidate > safetyCeiling) {
            violations.push(
                `review_remediation_mode_policy.${key} cannot exceed mandatory safety ceiling ${safetyCeiling}.`
            );
        }
    }
    return violations;
}

export function validateReviewRemediationModePolicy(value: unknown): ReviewRemediationModePolicy {
    const violations = getReviewRemediationModePolicyViolations(value);
    if (violations.length > 0) {
        throw new Error(`Review remediation mode policy is invalid: ${violations.join(' ')}`);
    }
    return clonePolicy(value as unknown as ReviewRemediationModePolicy);
}

export function resolveReviewRemediationModePolicyFromSnapshot(
    snapshot: unknown
): ReviewRemediationModePolicyResolution {
    if (!isPlainRecord(snapshot) || snapshot.review_remediation_mode_policy === undefined) {
        return {
            policy: buildDefaultReviewRemediationModePolicy(),
            diagnostics: [LEGACY_FALLBACK_DIAGNOSTIC],
            legacy_fallback: true
        };
    }
    const diagnostics = Array.isArray(snapshot.review_remediation_mode_policy_diagnostics)
        ? snapshot.review_remediation_mode_policy_diagnostics.map((entry) => String(entry))
        : [];
    return {
        policy: validateReviewRemediationModePolicy(snapshot.review_remediation_mode_policy),
        diagnostics,
        legacy_fallback: false
    };
}

function booleanRecord(value: unknown): Record<string, unknown> {
    return isPlainRecord(value) ? value : {};
}

export function collectReviewRemediationProtectedBoundarySignals(options: {
    changedFiles: readonly string[];
    preflight?: unknown;
}): ReviewRemediationProtectedBoundarySignal[] {
    const signals = new Set<ReviewRemediationProtectedBoundarySignal>();
    const preflight = booleanRecord(options.preflight);
    const triggers = booleanRecord(preflight.triggers);
    const requiredReviews = booleanRecord(preflight.required_reviews);
    const signalByReviewType: Readonly<Record<string, ReviewRemediationProtectedBoundarySignal>> = {
        api: 'api_contract',
        db: 'database',
        dependency: 'dependency',
        infra: 'infrastructure',
        security: 'security'
    };
    for (const [reviewType, signal] of Object.entries(signalByReviewType)) {
        if (triggers[reviewType] === true || requiredReviews[reviewType] === true) {
            signals.add(signal);
        }
    }
    if (
        triggers.protected_control_plane_changed === true
        || (Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0)
    ) {
        signals.add('protected_control_plane');
    }
    for (const rawPath of options.changedFiles) {
        const filePath = normalizePath(rawPath);
        for (const entry of DENY_ONLY_PATH_SIGNALS) {
            if (entry.pattern.test(filePath)) {
                signals.add(entry.signal);
            }
        }
    }
    return [...signals].sort();
}

export function evaluateReviewRemediationMode(options: {
    policy: ReviewRemediationModePolicy;
    legacyFallback?: boolean;
    reviewType: string;
    category: ReviewRemediationDeltaCategory;
    changedFilesCount: number;
    changedLinesTotal: number | null;
    consecutiveDeltaReviews: number;
    protectedBoundarySignals?: readonly ReviewRemediationProtectedBoundarySignal[];
    initialReview?: boolean;
    taskCriteriaChanged?: boolean;
    policyChanged?: boolean;
    scopeMembershipChanged?: boolean;
    uncertainCrossFileImpact?: boolean;
    existingFullReviewReasons?: readonly string[];
}): ReviewRemediationModeAssessment {
    const policy = validateReviewRemediationModePolicy(options.policy);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const fullReviewReasons = new Set<string>(options.existingFullReviewReasons ?? []);
    const deltaChainDepth = Number.isInteger(options.consecutiveDeltaReviews)
        && options.consecutiveDeltaReviews >= 0
        ? options.consecutiveDeltaReviews
        : 0;
    const protectedBoundarySignals = [...new Set(
        (options.protectedBoundarySignals ?? []).filter((signal) => (
            (REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS as readonly string[]).includes(signal)
        ))
    )].sort();
    if (options.legacyFallback === true) {
        fullReviewReasons.add('legacy profile snapshot has no immutable remediation mode policy');
    }
    if (options.initialReview === true) {
        fullReviewReasons.add('initial review must use FULL mode');
    }
    if (!policy.delta_eligible_review_types.includes(reviewType)) {
        fullReviewReasons.add(`review lane '${reviewType || 'unknown'}' is not DELTA-eligible`);
    }
    if (policy.force_full_categories.includes(options.category)) {
        fullReviewReasons.add(`remediation category '${options.category}' requires FULL mode`);
    }
    if (!Number.isInteger(options.changedFilesCount) || options.changedFilesCount < 1) {
        fullReviewReasons.add('remediation delta must contain at least one changed file');
    } else if (options.changedFilesCount > policy.max_delta_changed_files) {
        fullReviewReasons.add(
            `remediation delta changes ${options.changedFilesCount} files, above bound ${policy.max_delta_changed_files}`
        );
    }
    if (options.changedLinesTotal === null) {
        fullReviewReasons.add('remediation changed-line impact is unavailable');
    } else if (options.changedLinesTotal > policy.max_delta_changed_lines) {
        fullReviewReasons.add(
            `remediation delta changes ${options.changedLinesTotal} lines, above bound ${policy.max_delta_changed_lines}`
        );
    }
    if (deltaChainDepth >= policy.max_consecutive_delta_reviews) {
        fullReviewReasons.add(
            `periodic FULL review is due after ${policy.max_consecutive_delta_reviews} consecutive DELTA reviews`
        );
    }
    for (const signal of protectedBoundarySignals) {
        fullReviewReasons.add(`protected boundary signal '${signal}' requires FULL mode`);
    }
    if (options.taskCriteriaChanged === true) {
        fullReviewReasons.add('task criteria changed after the authenticated review baseline');
    }
    if (options.policyChanged === true) {
        fullReviewReasons.add('review policy changed after the authenticated review baseline');
    }
    if (options.scopeMembershipChanged === true) {
        fullReviewReasons.add('full review scope membership changed after the authenticated review baseline');
    }
    if (options.uncertainCrossFileImpact === true) {
        fullReviewReasons.add('cross-file remediation impact is uncertain');
    }
    const normalizedReasons = [...fullReviewReasons].filter(Boolean).sort();
    const mode = normalizedReasons.length > 0 ? 'FULL' as const : 'DELTA' as const;
    const policySha256 = sha256RedactedJsonPayload(policy);
    const assessmentWithoutHash: Omit<ReviewRemediationModeAssessment, 'assessment_sha256'> = {
        policy_id: policy.policy_id,
        policy_sha256: policySha256,
        legacy_fallback: options.legacyFallback === true,
        mode,
        delta_chain_depth: deltaChainDepth,
        protected_boundary_signals: protectedBoundarySignals,
        delta_eligible_review_types: mode === 'DELTA'
            ? [...policy.delta_eligible_review_types]
            : [],
        full_review_reasons: normalizedReasons
    };
    return {
        ...assessmentWithoutHash,
        assessment_sha256: sha256RedactedJsonPayload(assessmentWithoutHash)
    };
}

export function getReviewRemediationModeAssessmentViolations(options: {
    assessment: unknown;
    policy: ReviewRemediationModePolicy;
    legacyFallback: boolean;
    expectedProtectedBoundarySignals?: readonly ReviewRemediationProtectedBoundarySignal[];
    reviewType?: string;
    category?: ReviewRemediationDeltaCategory;
    changedFilesCount?: number;
    changedLinesTotal?: number | null;
}): string[] {
    if (!isPlainRecord(options.assessment)) {
        return ['remediation delta mode_policy_assessment is missing.'];
    }
    const violations: string[] = [];
    const policy = validateReviewRemediationModePolicy(options.policy);
    const assessment = options.assessment;
    if (assessment.policy_id !== policy.policy_id) {
        violations.push('remediation delta mode policy id does not match the frozen profile policy.');
    }
    if (assessment.policy_sha256 !== sha256RedactedJsonPayload(policy)) {
        violations.push('remediation delta mode policy hash does not match the frozen profile policy.');
    }
    if (assessment.legacy_fallback !== options.legacyFallback) {
        violations.push('remediation delta legacy mode-policy fallback binding is inconsistent.');
    }
    if (options.legacyFallback && assessment.mode !== 'FULL') {
        violations.push('legacy remediation mode-policy fallback requires FULL mode.');
    }
    if (!['FULL', 'DELTA'].includes(String(assessment.mode || ''))) {
        violations.push('remediation delta mode policy assessment mode must be FULL or DELTA.');
    }
    const reasons = canonicalStringList(assessment.full_review_reasons);
    const eligibleReviewTypes = normalizedStringList(assessment.delta_eligible_review_types);
    const protectedSignals = normalizedStringList(assessment.protected_boundary_signals);
    const expectedProtectedSignals = [...new Set(
        options.expectedProtectedBoundarySignals ?? []
    )].sort();
    if (!reasons || !eligibleReviewTypes || !protectedSignals) {
        violations.push('remediation delta mode policy assessment arrays must be canonical.');
    } else {
        if ((assessment.mode === 'FULL') !== (reasons.length > 0)) {
            violations.push('remediation delta mode must agree with full_review_reasons.');
        }
        if (assessment.mode === 'DELTA' && eligibleReviewTypes.some((entry) => !policy.delta_eligible_review_types.includes(entry))) {
            violations.push('remediation delta mode policy assessment weakens frozen lane eligibility.');
        }
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (
            assessment.mode === 'DELTA'
            && reviewType
            && (!policy.delta_eligible_review_types.includes(reviewType) || !eligibleReviewTypes.includes(reviewType))
        ) {
            violations.push('remediation DELTA origin lane is not eligible under the frozen mode policy.');
        }
        if (
            assessment.mode === 'DELTA'
            && options.category
            && policy.force_full_categories.includes(options.category)
        ) {
            violations.push('remediation DELTA category requires FULL under the frozen mode policy.');
        }
        if (
            assessment.mode === 'DELTA'
            && options.changedFilesCount !== undefined
            && (
                !Number.isInteger(options.changedFilesCount)
                || options.changedFilesCount < 1
                || options.changedFilesCount > policy.max_delta_changed_files
            )
        ) {
            violations.push('remediation DELTA changed-file count exceeds the frozen mode-policy bound.');
        }
        if (
            assessment.mode === 'DELTA'
            && options.changedLinesTotal !== undefined
            && (
                options.changedLinesTotal === null
                || !Number.isInteger(options.changedLinesTotal)
                || options.changedLinesTotal < 0
                || options.changedLinesTotal > policy.max_delta_changed_lines
            )
        ) {
            violations.push('remediation DELTA changed-line count exceeds the frozen mode-policy bound.');
        }
        if (
            assessment.mode === 'DELTA'
            && Number(assessment.delta_chain_depth) >= policy.max_consecutive_delta_reviews
        ) {
            violations.push('remediation DELTA exceeds the frozen periodic-FULL chain bound.');
        }
        if (assessment.mode === 'DELTA' && protectedSignals.length > 0) {
            violations.push('remediation DELTA cannot carry protected boundary signals.');
        }
        const omittedProtectedSignals = expectedProtectedSignals.filter((signal) => (
            !protectedSignals.includes(signal)
        ));
        if (omittedProtectedSignals.length > 0) {
            violations.push(
                `remediation mode policy assessment omits expected protected boundary signals: ${omittedProtectedSignals.join(', ')}.`
            );
        }
        if (assessment.mode === 'FULL' && eligibleReviewTypes.length > 0) {
            violations.push('FULL remediation mode must not expose DELTA-eligible lanes.');
        }
        if (protectedSignals.some((entry) => (
            !(REVIEW_REMEDIATION_PROTECTED_BOUNDARY_SIGNALS as readonly string[]).includes(entry)
        ))) {
            violations.push('remediation delta mode policy assessment contains an unknown protected signal.');
        }
    }
    if (!Number.isInteger(assessment.delta_chain_depth) || Number(assessment.delta_chain_depth) < 0) {
        violations.push('remediation delta mode policy assessment delta_chain_depth is invalid.');
    }
    const assessmentWithoutHash = { ...assessment };
    delete assessmentWithoutHash.assessment_sha256;
    if (assessment.assessment_sha256 !== sha256RedactedJsonPayload(assessmentWithoutHash)) {
        violations.push('remediation delta mode policy assessment hash is invalid.');
    }
    return violations;
}
