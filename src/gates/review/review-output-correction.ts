import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { fileSha256 } from '../../gate-runtime/hash';
import { normalizePath } from '../shared/helpers';

export const REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE = 'review_output_correction';
export const REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE = 'review_output_correction_launch';
export const REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION = 1;
export const REVIEW_OUTPUT_CORRECTION_REQUIRED = 'REVIEW_OUTPUT_CORRECTION_REQUIRED';
export const DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT = 2;

const MISSING_FINDINGS_FINGERPRINT_REASON =
    'Rejected review output has no semantic findings fingerprint; correction-only recovery cannot prove findings preservation.';

export type ReviewOutputCorrectionState =
    | typeof REVIEW_OUTPUT_CORRECTION_REQUIRED
    | 'CORRECTION_ACCEPTED'
    | 'FULL_REVIEW_REQUIRED';

export type ReviewOutputCorrectionDiagnosticCategory = 'mechanical' | 'semantic' | 'provenance';

export type ReviewOutputCorrectionDiagnosticCode =
    | 'SCHEMA_BINDING'
    | 'TASK_BINDING'
    | 'REVIEW_TYPE_BINDING'
    | 'CONTEXT_BINDING'
    | 'TREE_BINDING'
    | 'COVERAGE_BINDING'
    | 'EXECUTION_BINDING'
    | 'FINDINGS_SEMANTICS'
    | 'PROVENANCE_BINDING'
    | 'UNCLASSIFIED_VALIDATION';

export interface ReviewOutputCorrectionDiagnostic {
    code: ReviewOutputCorrectionDiagnosticCode;
    category: ReviewOutputCorrectionDiagnosticCategory;
    message: string;
    mechanically_correctable: boolean;
}

export type ReviewOutputCorrectionTransport =
    | 'gate_normalization'
    | 'live_reviewer_continuation'
    | 'api_conversation_continuation'
    | 'correction_only_invocation'
    | 'full_reviewer_relaunch';

export interface ReviewOutputCorrectionCapabilities {
    gate_normalization: boolean;
    live_reviewer_continuation: boolean;
    api_conversation_continuation: boolean;
    correction_only_invocation: boolean;
}

export interface ReviewOutputCorrectionBinding {
    original_output_path: string;
    original_output_sha256: string;
    review_context_path: string;
    review_context_sha256: string;
    review_tree_state_sha256: string;
    reviewer_identity: string;
    reviewer_attempt_id: string;
    reviewer_invocation_event_sha256: string | null;
    findings_semantic_fingerprint: string | null;
    validation_artifact_path: string;
    validation_artifact_sha256: string;
}

export type ReviewOutputCorrectionProviderAction =
    | 'gate_normalization'
    | 'continue_delegated_reviewer'
    | 'continue_api_conversation'
    | 'launch_correction_only_reviewer'
    | 'launch_full_reviewer';

export interface ReviewOutputCorrectionHandoff {
    provider_action: ReviewOutputCorrectionProviderAction;
    launch_input_mode: 'review_output_correction_artifact_path';
    launch_input_artifact_path: string | null;
    target_reviewer_identity: string | null;
    fork_context: false | null;
    result_delivery: 'record_review_result_stdin';
    instruction: string;
}

export interface ReviewOutputCorrectionArtifact {
    schema_version: 1;
    artifact_type: typeof REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    state: ReviewOutputCorrectionState;
    created_at_utc: string;
    updated_at_utc: string;
    binding: ReviewOutputCorrectionBinding;
    diagnostics: ReviewOutputCorrectionDiagnostic[];
    recovery: {
        correction_attempt: number;
        max_correction_attempts: number;
        selected_transport: ReviewOutputCorrectionTransport;
        available_transports: ReviewOutputCorrectionTransport[];
        reason: string;
        handoff?: ReviewOutputCorrectionHandoff;
    };
    artifact_sha256?: string;
}

export interface ReviewOutputMechanicalBindings {
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    coverageContractSha256?: string | null;
    reviewExecution?: Record<string, unknown> | null;
}

export interface ReviewOutputCorrectionTransportAdapter {
    id: string;
    capabilities: ReviewOutputCorrectionCapabilities;
    continueReview?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
    continueApiConversation?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
    invokeCorrectionOnly?: (correction: ReviewOutputCorrectionArtifact) => Promise<string>;
}

export interface ReviewOutputCorrectionVerification {
    valid: boolean;
    requires_full_review: boolean;
    violations: string[];
}

export interface ReviewOutputCorrectionProducerAttestation {
    producer_identity: string;
    provider_invocation_id: string;
    provider_invocation_event_sha256: string;
    attestation_source: string;
    launch_input_sha256: string;
    fork_context: boolean | null;
}

export interface ReviewOutputCorrectionProducerInvocationEvidence {
    event_type: string;
    event_sha256: string;
    reviewer_identity: string;
    reviewer_attempt_id: string;
    provider_invocation_id: string;
    review_context_sha256: string;
    launch_input_sha256: string;
    delegation_started_event_type: string;
    delegation_started_event_sha256: string;
    delegation_started_reviewer_identity: string;
    delegation_started_provider_invocation_id: string;
    correction_launch_artifact_sha256: string;
}

const MECHANICAL_PATTERNS: ReadonlyArray<readonly [RegExp, ReviewOutputCorrectionDiagnosticCode]> = [
    [/schema_version/iu, 'SCHEMA_BINDING'],
    [/task_id/iu, 'TASK_BINDING'],
    [/review_type/iu, 'REVIEW_TYPE_BINDING'],
    [/review_context_sha256/iu, 'CONTEXT_BINDING'],
    [/tree_state_sha256/iu, 'TREE_BINDING'],
    [/coverage_contract_sha256/iu, 'COVERAGE_BINDING'],
    [/review_execution(?:\.|\b)|execution evidence|execution contract/iu, 'EXECUTION_BINDING']
];

const PROVENANCE_PATTERN = /provenance|reviewer identity|reviewer attempt|tamper|original output|context changed|tree state changed/iu;
const SEMANTIC_PATTERN = /findings?\.|finding\b|residual_risks?|evidence\b|validation_notes?|coverage_ledger\.entries/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function computeRawReviewOutputSha256(rawOutput: string): string {
    return hashText(rawOutput);
}

function safeParseJsonObject(content: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function computeReviewFindingsSemanticFingerprint(content: string): string | null {
    const parsed = safeParseJsonObject(content);
    const findings = isRecord(parsed?.findings) ? parsed.findings : null;
    if (!findings) {
        return null;
    }
    return sha256RedactedJsonPayload(canonicalize(findings));
}

export function buildReviewOutputCorrectionHandoff(options: {
    transport: ReviewOutputCorrectionTransport;
    reviewerIdentity: string;
    correctionArtifactPath?: string | null;
}): ReviewOutputCorrectionHandoff {
    const launchInputArtifactPath = options.correctionArtifactPath
        ? normalizePath(options.correctionArtifactPath)
        : null;
    const common = {
        launch_input_mode: 'review_output_correction_artifact_path' as const,
        launch_input_artifact_path: launchInputArtifactPath,
        result_delivery: 'record_review_result_stdin' as const
    };
    if (options.transport === 'live_reviewer_continuation') {
        return {
            ...common,
            provider_action: 'continue_delegated_reviewer',
            target_reviewer_identity: options.reviewerIdentity,
            fork_context: null,
            instruction:
                'Continue the named delegated reviewer with only ReviewerCorrectionInputArtifactPath. ' +
                'The reviewer must apply the bound validator diagnostics without changing findings, return exactly one corrected JSON object, ' +
                'and stop; then pipe that object to the navigator-provided record-review-result command.'
        };
    }
    if (options.transport === 'api_conversation_continuation') {
        return {
            ...common,
            provider_action: 'continue_api_conversation',
            target_reviewer_identity: options.reviewerIdentity,
            fork_context: null,
            instruction:
                'Continue the bound provider conversation with only ReviewerCorrectionInputArtifactPath. ' +
                'Return exactly one corrected JSON object without changing findings, then pipe it to the navigator-provided record-review-result command.'
        };
    }
    if (options.transport === 'correction_only_invocation') {
        return {
            ...common,
            provider_action: 'launch_correction_only_reviewer',
            target_reviewer_identity: null,
            fork_context: false,
            instruction:
                'Launch one clean-context correction-only reviewer with only ReviewerCorrectionInputArtifactPath. ' +
                'It may repair the bound validation defects but must not change findings; it must return exactly one corrected JSON object and stop. ' +
                'Then pipe that object to the navigator-provided record-review-result command with the resolved correction producer attestation.'
        };
    }
    return {
        ...common,
        provider_action: options.transport === 'gate_normalization'
            ? 'gate_normalization'
            : 'launch_full_reviewer',
        target_reviewer_identity: null,
        fork_context: options.transport === 'full_reviewer_relaunch' ? false : null,
        instruction: options.transport === 'gate_normalization'
            ? 'No provider action is required; the gate owns deterministic normalization.'
            : 'Correction-only recovery is unavailable; restart the review cycle and launch one fresh full reviewer.'
    };
}

export function classifyReviewOutputCorrectionDiagnostics(
    violations: readonly string[]
): ReviewOutputCorrectionDiagnostic[] {
    return violations.map((rawViolation) => {
        const message = String(rawViolation || '').trim() || 'Review output validation failed without details.';
        const mechanical = MECHANICAL_PATTERNS.find(([pattern]) => pattern.test(message));
        if (mechanical && !SEMANTIC_PATTERN.test(message.replace(mechanical[0], ''))) {
            return {
                code: mechanical[1],
                category: 'mechanical' as const,
                message,
                mechanically_correctable: true
            };
        }
        if (PROVENANCE_PATTERN.test(message)) {
            return {
                code: 'PROVENANCE_BINDING' as const,
                category: 'provenance' as const,
                message,
                mechanically_correctable: false
            };
        }
        if (SEMANTIC_PATTERN.test(message)) {
            return {
                code: 'FINDINGS_SEMANTICS' as const,
                category: 'semantic' as const,
                message,
                mechanically_correctable: false
            };
        }
        return {
            code: 'UNCLASSIFIED_VALIDATION' as const,
            category: 'semantic' as const,
            message,
            mechanically_correctable: false
        };
    });
}

export function normalizeReviewOutputMechanically(options: {
    content: string;
    diagnostics: readonly ReviewOutputCorrectionDiagnostic[];
    bindings: ReviewOutputMechanicalBindings;
}): { normalized: boolean; content: string; fingerprint: string | null } {
    if (
        options.diagnostics.length === 0
        || options.diagnostics.some((diagnostic) => !diagnostic.mechanically_correctable)
    ) {
        return {
            normalized: false,
            content: options.content,
            fingerprint: computeReviewFindingsSemanticFingerprint(options.content)
        };
    }
    const parsed = safeParseJsonObject(options.content);
    if (!parsed) {
        return { normalized: false, content: options.content, fingerprint: null };
    }
    const originalFingerprint = computeReviewFindingsSemanticFingerprint(options.content);
    parsed.schema_version = 2;
    parsed.task_id = options.bindings.taskId;
    parsed.review_type = options.bindings.reviewType;
    parsed.review_context_sha256 = options.bindings.reviewContextSha256;
    parsed.tree_state_sha256 = options.bindings.reviewTreeStateSha256;
    if (isRecord(parsed.coverage_ledger) && normalizeSha256(options.bindings.coverageContractSha256)) {
        parsed.coverage_ledger.coverage_contract_sha256 = normalizeSha256(options.bindings.coverageContractSha256);
    }
    if (options.bindings.reviewExecution) {
        parsed.review_execution = structuredClone(options.bindings.reviewExecution);
    }
    const normalizedContent = `${JSON.stringify(parsed, null, 2)}\n`;
    if (computeReviewFindingsSemanticFingerprint(normalizedContent) !== originalFingerprint) {
        throw new Error('Gate-owned mechanical normalization changed the findings semantic fingerprint.');
    }
    return { normalized: normalizedContent !== options.content, content: normalizedContent, fingerprint: originalFingerprint };
}

export function resolveReviewOutputCorrectionTransport(options: {
    diagnostics: readonly ReviewOutputCorrectionDiagnostic[];
    capabilities: ReviewOutputCorrectionCapabilities;
    correctionAttempt: number;
    maxCorrectionAttempts?: number;
    forceFullReviewReasons?: readonly string[];
}): { transport: ReviewOutputCorrectionTransport; reason: string; available: ReviewOutputCorrectionTransport[] } {
    const limit = options.maxCorrectionAttempts ?? DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT;
    const available: ReviewOutputCorrectionTransport[] = [];
    if (options.capabilities.gate_normalization) available.push('gate_normalization');
    if (options.capabilities.live_reviewer_continuation) available.push('live_reviewer_continuation');
    if (options.capabilities.api_conversation_continuation) available.push('api_conversation_continuation');
    if (options.capabilities.correction_only_invocation) available.push('correction_only_invocation');
    available.push('full_reviewer_relaunch');
    const forceReasons = (options.forceFullReviewReasons || []).map((reason) => reason.trim()).filter(Boolean);
    if (forceReasons.length > 0) {
        return { transport: 'full_reviewer_relaunch', reason: forceReasons.join(' '), available };
    }
    if (options.correctionAttempt > limit) {
        return {
            transport: 'full_reviewer_relaunch',
            reason: `Correction recovery exhausted its bound of ${limit} attempt(s).`,
            available
        };
    }
    const mechanicalOnly = options.diagnostics.length > 0
        && options.diagnostics.every((diagnostic) => diagnostic.mechanically_correctable);
    if (mechanicalOnly && options.capabilities.gate_normalization) {
        return { transport: 'gate_normalization', reason: 'All violations are mechanically derivable bindings.', available };
    }
    if (options.capabilities.live_reviewer_continuation) {
        return { transport: 'live_reviewer_continuation', reason: 'The original delegated reviewer session is available.', available };
    }
    if (options.capabilities.api_conversation_continuation) {
        return { transport: 'api_conversation_continuation', reason: 'The provider supports bound conversation continuation.', available };
    }
    if (options.capabilities.correction_only_invocation) {
        return { transport: 'correction_only_invocation', reason: 'Use one bounded correction-only invocation.', available };
    }
    return {
        transport: 'full_reviewer_relaunch',
        reason: 'No authenticated correction transport is available.',
        available
    };
}

export function getReviewOutputCorrectionArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-output-correction.json');
}

export function getReviewOutputCorrectionLaunchArtifactPath(reviewArtifactPath: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, '-output-correction-launch.json');
}

export function getRejectedReviewOutputArtifactPath(reviewArtifactPath: string, outputSha256: string): string {
    return String(reviewArtifactPath || '').replace(/\.md$/u, `-rejected-output-${outputSha256}.md`);
}

function withArtifactSha256(
    artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'>
): ReviewOutputCorrectionArtifact {
    return {
        ...artifact,
        artifact_sha256: sha256RedactedJsonPayload(artifact)
    };
}

export function buildReviewOutputCorrectionArtifact(options: {
    taskId: string;
    reviewType: string;
    rejectedOutputPath: string;
    rejectedOutputSha256: string;
    rejectedOutputContent?: string;
    reviewContextPath: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    reviewerIdentity: string;
    reviewerAttemptId: string;
    reviewerInvocationEventSha256: string | null;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    violations: readonly string[];
    correctionAttempt?: number;
    maxCorrectionAttempts?: number;
    capabilities?: Partial<ReviewOutputCorrectionCapabilities>;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const diagnostics = classifyReviewOutputCorrectionDiagnostics(options.violations);
    const correctionAttempt = Math.max(1, options.correctionAttempt || 1);
    const maxCorrectionAttempts = Math.max(1, options.maxCorrectionAttempts || DEFAULT_REVIEW_OUTPUT_CORRECTION_LIMIT);
    const rejectedContent = options.rejectedOutputContent ?? (
        fs.existsSync(options.rejectedOutputPath)
            ? fs.readFileSync(options.rejectedOutputPath, 'utf8')
            : ''
    );
    const findingsSemanticFingerprint = rejectedContent
        ? computeReviewFindingsSemanticFingerprint(rejectedContent)
        : null;
    const capabilities: ReviewOutputCorrectionCapabilities = {
        gate_normalization: options.capabilities?.gate_normalization === true,
        live_reviewer_continuation: options.capabilities?.live_reviewer_continuation === true,
        api_conversation_continuation: options.capabilities?.api_conversation_continuation === true,
        correction_only_invocation: options.capabilities?.correction_only_invocation !== false
    };
    const recovery = resolveReviewOutputCorrectionTransport({
        diagnostics,
        capabilities,
        correctionAttempt,
        maxCorrectionAttempts,
        forceFullReviewReasons: findingsSemanticFingerprint
            ? []
            : [MISSING_FINDINGS_FINGERPRINT_REASON]
    });
    const timestamp = options.now || new Date().toISOString();
    const artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> = {
        schema_version: REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION as 1,
        artifact_type: REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE,
        task_id: options.taskId,
        review_type: options.reviewType,
        state: recovery.transport === 'full_reviewer_relaunch'
            ? 'FULL_REVIEW_REQUIRED'
            : REVIEW_OUTPUT_CORRECTION_REQUIRED,
        created_at_utc: timestamp,
        updated_at_utc: timestamp,
        binding: {
            original_output_path: normalizePath(options.rejectedOutputPath),
            original_output_sha256: options.rejectedOutputSha256.toLowerCase(),
            review_context_path: normalizePath(options.reviewContextPath),
            review_context_sha256: options.reviewContextSha256.toLowerCase(),
            review_tree_state_sha256: options.reviewTreeStateSha256.toLowerCase(),
            reviewer_identity: options.reviewerIdentity,
            reviewer_attempt_id: options.reviewerAttemptId,
            reviewer_invocation_event_sha256: normalizeSha256(options.reviewerInvocationEventSha256),
            findings_semantic_fingerprint: findingsSemanticFingerprint,
            validation_artifact_path: normalizePath(options.validationArtifactPath),
            validation_artifact_sha256: options.validationArtifactSha256.toLowerCase()
        },
        diagnostics,
        recovery: {
            correction_attempt: correctionAttempt,
            max_correction_attempts: maxCorrectionAttempts,
            selected_transport: recovery.transport,
            available_transports: recovery.available,
            reason: recovery.reason,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: recovery.transport,
                reviewerIdentity: options.reviewerIdentity
            })
        }
    };
    return withArtifactSha256(artifact);
}

function assertPathInsideRepo(repoRoot: string, targetPath: string, label: string): string {
    const root = path.resolve(repoRoot);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${label} must resolve to a file inside repo root.`);
    }
    const realRoot = fs.realpathSync.native(root);
    let existingAncestor = target;
    while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
            throw new Error(`${label} has no existing ancestor inside repo root.`);
        }
        existingAncestor = parent;
    }
    const realAncestor = fs.realpathSync.native(existingAncestor);
    const realTarget = path.resolve(realAncestor, path.relative(existingAncestor, target));
    const realRelative = path.relative(realRoot, realTarget);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error(`${label} must not traverse a symlink or junction outside repo root.`);
    }
    return target;
}

export function persistReviewOutputCorrection(options: {
    repoRoot: string;
    reviewArtifactPath: string;
    rawOutput: string;
    artifact: Omit<ReviewOutputCorrectionArtifact, 'artifact_sha256'> | ReviewOutputCorrectionArtifact;
}): {
    artifactPath: string;
    rejectedOutputPath: string;
    correctionLaunchArtifactPath: string | null;
    artifact: ReviewOutputCorrectionArtifact;
} {
    const rawOutputSha256 = computeRawReviewOutputSha256(options.rawOutput);
    const rejectedOutputPath = assertPathInsideRepo(
        options.repoRoot,
        getRejectedReviewOutputArtifactPath(options.reviewArtifactPath, rawOutputSha256),
        'Rejected review output path'
    );
    const artifactPath = assertPathInsideRepo(
        options.repoRoot,
        getReviewOutputCorrectionArtifactPath(options.reviewArtifactPath),
        'Review output correction artifact path'
    );
    const correctionLaunchArtifactPath = assertPathInsideRepo(
        options.repoRoot,
        getReviewOutputCorrectionLaunchArtifactPath(options.reviewArtifactPath),
        'Review output correction launch artifact path'
    );
    const artifactWithoutHash = { ...options.artifact } as ReviewOutputCorrectionArtifact;
    delete artifactWithoutHash.artifact_sha256;
    const previousCorrection = fs.existsSync(artifactPath)
        ? readReviewOutputCorrectionArtifact(artifactPath)
        : { artifact: null, violations: [] as string[] };
    const previousArtifact = previousCorrection.violations.length === 0
        ? previousCorrection.artifact
        : null;
    const preservesPreviousAttempt = Boolean(
        artifactWithoutHash.recovery.correction_attempt > 1
        && previousArtifact?.state === REVIEW_OUTPUT_CORRECTION_REQUIRED
        && previousArtifact.task_id === artifactWithoutHash.task_id
        && previousArtifact.review_type === artifactWithoutHash.review_type
        && previousArtifact.binding.review_context_sha256 === artifactWithoutHash.binding.review_context_sha256
        && previousArtifact.binding.review_tree_state_sha256 === artifactWithoutHash.binding.review_tree_state_sha256
        && previousArtifact.binding.reviewer_identity === artifactWithoutHash.binding.reviewer_identity
        && previousArtifact.binding.reviewer_attempt_id === artifactWithoutHash.binding.reviewer_attempt_id
        && previousArtifact.recovery.correction_attempt + 1 === artifactWithoutHash.recovery.correction_attempt
    );
    if (artifactWithoutHash.recovery.correction_attempt > 1 && !preservesPreviousAttempt) {
        throw new Error(
            'Repeated review output correction cannot preserve the authenticated original rejected-output binding.'
        );
    }
    const preservedOriginalOutputPath = preservesPreviousAttempt && previousArtifact
        ? assertPathInsideRepo(
            options.repoRoot,
            previousArtifact.binding.original_output_path,
            'Original rejected review output path'
        )
        : rejectedOutputPath;
    const preservedOriginalOutputSha256 = preservesPreviousAttempt && previousArtifact
        ? previousArtifact.binding.original_output_sha256
        : rawOutputSha256;
    const findingsSemanticFingerprint = preservesPreviousAttempt && previousArtifact
        ? previousArtifact.binding.findings_semantic_fingerprint
        : computeReviewFindingsSemanticFingerprint(options.rawOutput);
    writeFileAtomically(rejectedOutputPath, options.rawOutput, { encoding: 'utf8' });
    artifactWithoutHash.binding = {
        ...artifactWithoutHash.binding,
        original_output_path: normalizePath(preservedOriginalOutputPath),
        original_output_sha256: preservedOriginalOutputSha256,
        findings_semantic_fingerprint: findingsSemanticFingerprint
    };
    artifactWithoutHash.recovery = {
        ...artifactWithoutHash.recovery,
        handoff: buildReviewOutputCorrectionHandoff({
            transport: artifactWithoutHash.recovery.selected_transport,
            reviewerIdentity: artifactWithoutHash.binding.reviewer_identity,
            correctionArtifactPath: artifactPath
        })
    };
    if (!findingsSemanticFingerprint) {
        artifactWithoutHash.state = 'FULL_REVIEW_REQUIRED';
        artifactWithoutHash.recovery = {
            ...artifactWithoutHash.recovery,
            selected_transport: 'full_reviewer_relaunch',
            reason: MISSING_FINDINGS_FINGERPRINT_REASON,
            handoff: buildReviewOutputCorrectionHandoff({
                transport: 'full_reviewer_relaunch',
                reviewerIdentity: artifactWithoutHash.binding.reviewer_identity,
                correctionArtifactPath: artifactPath
            })
        };
    }
    const artifact = withArtifactSha256(artifactWithoutHash);
    writeFileAtomically(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8' });
    const artifactFileSha256 = fileSha256(artifactPath) || '';
    let preparedLaunchArtifactPath: string | null = null;
    if (
        artifact.state === REVIEW_OUTPUT_CORRECTION_REQUIRED
        && artifact.recovery.selected_transport === 'correction_only_invocation'
        && /^[0-9a-f]{64}$/u.test(artifactFileSha256)
    ) {
        writeFileAtomically(correctionLaunchArtifactPath, `${JSON.stringify({
            schema_version: 1,
            artifact_type: REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE,
            state: 'prepared',
            task_id: artifact.task_id,
            review_type: artifact.review_type,
            correction_artifact_path: normalizePath(artifactPath),
            correction_artifact_sha256: artifactFileSha256,
            launch_input_sha256: artifactFileSha256,
            original_reviewer_identity: artifact.binding.reviewer_identity,
            original_reviewer_attempt_id: artifact.binding.reviewer_attempt_id,
            review_context_sha256: artifact.binding.review_context_sha256,
            review_tree_state_sha256: artifact.binding.review_tree_state_sha256,
            prepared_at_utc: artifact.updated_at_utc
        }, null, 2)}\n`, { encoding: 'utf8' });
        preparedLaunchArtifactPath = correctionLaunchArtifactPath;
    }
    return {
        artifactPath,
        rejectedOutputPath,
        correctionLaunchArtifactPath: preparedLaunchArtifactPath,
        artifact
    };
}

export function readReviewOutputCorrectionArtifact(artifactPath: string): {
    artifact: ReviewOutputCorrectionArtifact | null;
    violations: string[];
} {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { artifact: null, violations: [`Review output correction artifact is missing: ${normalizePath(artifactPath)}.`] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
    } catch {
        return { artifact: null, violations: [`Review output correction artifact is not valid JSON: ${normalizePath(artifactPath)}.`] };
    }
    if (!isRecord(parsed)) {
        return { artifact: null, violations: ['Review output correction artifact must be a JSON object.'] };
    }
    const artifact = parsed as unknown as ReviewOutputCorrectionArtifact;
    const violations: string[] = [];
    if (
        artifact.schema_version !== REVIEW_OUTPUT_CORRECTION_SCHEMA_VERSION
        || artifact.artifact_type !== REVIEW_OUTPUT_CORRECTION_ARTIFACT_TYPE
        || !isRecord(artifact.binding)
        || !isRecord(artifact.recovery)
        || !Array.isArray(artifact.diagnostics)
    ) {
        violations.push('Review output correction artifact has invalid shape.');
        return { artifact: null, violations };
    }
    const declaredSha256 = normalizeSha256(artifact.artifact_sha256);
    const unhashed = { ...artifact };
    delete unhashed.artifact_sha256;
    if (!declaredSha256 || sha256RedactedJsonPayload(unhashed) !== declaredSha256) {
        violations.push('Review output correction artifact checksum is invalid.');
    }
    const originalOutputSha256 = normalizeSha256(artifact.binding.original_output_sha256);
    if (
        !originalOutputSha256
        || !fs.existsSync(artifact.binding.original_output_path)
        || fileSha256(artifact.binding.original_output_path) !== originalOutputSha256
    ) {
        violations.push('Review output correction original output binding is missing or tampered.');
    }
    const validationArtifactSha256 = normalizeSha256(artifact.binding.validation_artifact_sha256);
    if (
        !validationArtifactSha256
        || !fs.existsSync(artifact.binding.validation_artifact_path)
        || fileSha256(artifact.binding.validation_artifact_path) !== validationArtifactSha256
    ) {
        violations.push('Review output correction validation evidence binding is missing or tampered.');
    }
    return { artifact, violations };
}

export function buildReviewOutputCorrectionStateTransition(options: {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    state: ReviewOutputCorrectionState;
    reason: string;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const updatedWithoutHash = {
        ...options.artifact,
        state: options.state,
        updated_at_utc: options.now || new Date().toISOString(),
        recovery: {
            ...options.artifact.recovery,
            ...(options.state === 'FULL_REVIEW_REQUIRED'
                ? {
                    selected_transport: 'full_reviewer_relaunch' as const,
                    handoff: buildReviewOutputCorrectionHandoff({
                        transport: 'full_reviewer_relaunch',
                        reviewerIdentity: options.artifact.binding.reviewer_identity,
                        correctionArtifactPath: options.artifactPath
                    })
                }
                : {}),
            reason: options.reason
        }
    };
    delete updatedWithoutHash.artifact_sha256;
    return withArtifactSha256(updatedWithoutHash);
}

export function updateReviewOutputCorrectionState(options: {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    state: ReviewOutputCorrectionState;
    reason: string;
    now?: string;
}): ReviewOutputCorrectionArtifact {
    const updated = buildReviewOutputCorrectionStateTransition(options);
    writeFileAtomically(options.artifactPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8' });
    return updated;
}

export function verifyCorrectedReviewOutput(options: {
    artifact: ReviewOutputCorrectionArtifact;
    correctedOutput: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    originalReviewerIdentity: string;
    originalReviewerAttemptId: string;
    correctionArtifactSha256: string;
    producerAttestation: ReviewOutputCorrectionProducerAttestation;
    producerInvocationEvidence: ReviewOutputCorrectionProducerInvocationEvidence | null;
}): ReviewOutputCorrectionVerification {
    const violations: string[] = [];
    const binding = options.artifact.binding;
    const producer = options.producerAttestation;
    const invocationEvidence = options.producerInvocationEvidence;
    if (binding.review_context_sha256 !== options.reviewContextSha256.toLowerCase()) {
        violations.push('Review context changed after correction was requested.');
    }
    if (binding.review_tree_state_sha256 !== options.reviewTreeStateSha256.toLowerCase()) {
        violations.push('Review tree state changed after correction was requested.');
    }
    if (binding.reviewer_identity !== options.originalReviewerIdentity) {
        violations.push('Reviewer identity does not match the rejected output provenance.');
    }
    if (binding.reviewer_attempt_id !== options.originalReviewerAttemptId) {
        violations.push('Reviewer attempt does not match the rejected output provenance.');
    }
    if (options.artifact.state !== REVIEW_OUTPUT_CORRECTION_REQUIRED) {
        violations.push('Review output correction is not in a pending correction state.');
    }
    if (
        !/^agent:[^\s<>]+$/u.test(producer.producer_identity)
        || /^agent:pending:/iu.test(producer.producer_identity)
    ) {
        violations.push('Correction producer identity must be a resolved provider-owned agent identity.');
    }
    if (
        !producer.provider_invocation_id
        || /^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/iu.test(producer.provider_invocation_id)
    ) {
        violations.push('Correction provider invocation id must identify the actual provider invocation.');
    }
    if (!normalizeSha256(producer.provider_invocation_event_sha256)) {
        violations.push('Correction producer must reference provider-owned reviewer invocation evidence.');
    }
    if (
        !producer.attestation_source
        || /^(?:garda_prepare_reviewer_launch|orchestrator_mock|manual|mock|test|placeholder)$/iu.test(
            producer.attestation_source
        )
        || !/(?:spawn|subagent|task|tool|launch|run|invocation)/iu.test(producer.attestation_source)
    ) {
        violations.push('Correction attestation source must be provider/controller-owned invocation evidence.');
    }
    if (
        !normalizeSha256(options.correctionArtifactSha256)
        || normalizeSha256(producer.launch_input_sha256) !== normalizeSha256(options.correctionArtifactSha256)
    ) {
        violations.push('Correction producer launch input does not match the persisted correction package.');
    }
    if (!invocationEvidence) {
        violations.push('Correction producer invocation is not present in provider-owned task telemetry.');
    } else {
        if (invocationEvidence.event_type !== 'REVIEWER_INVOCATION_ATTESTED') {
            violations.push('Correction producer evidence is not a reviewer invocation attestation.');
        }
        if (
            invocationEvidence.event_sha256 !== normalizeSha256(producer.provider_invocation_event_sha256)
        ) {
            violations.push('Correction producer invocation evidence hash does not match the claimed provider event.');
        }
        if (invocationEvidence.reviewer_identity !== producer.producer_identity) {
            violations.push('Correction producer identity does not match provider-owned invocation evidence.');
        }
        if (invocationEvidence.provider_invocation_id !== producer.provider_invocation_id) {
            violations.push('Correction provider invocation id does not match provider-owned invocation evidence.');
        }
        if (invocationEvidence.review_context_sha256 !== binding.review_context_sha256) {
            violations.push('Correction producer invocation context does not match the rejected review context.');
        }
    }
    if (
        ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
            options.artifact.recovery.selected_transport
        )
        && producer.producer_identity !== binding.reviewer_identity
    ) {
        violations.push('Correction continuation producer does not match the original reviewer identity.');
    }
    if (
        ['live_reviewer_continuation', 'api_conversation_continuation'].includes(
            options.artifact.recovery.selected_transport
        )
        && (
            !invocationEvidence
            || invocationEvidence.event_sha256 !== binding.reviewer_invocation_event_sha256
            || invocationEvidence.reviewer_attempt_id !== binding.reviewer_attempt_id
        )
    ) {
        violations.push('Correction continuation is not bound to the original provider-owned reviewer invocation.');
    }
    if (options.artifact.recovery.selected_transport === 'correction_only_invocation') {
        if (producer.producer_identity === binding.reviewer_identity) {
            violations.push('Correction-only invocation must use a fresh reviewer identity.');
        }
        if (producer.fork_context !== false) {
            violations.push('Correction-only invocation must attest fork_context=false.');
        }
        if (invocationEvidence?.launch_input_sha256 !== normalizeSha256(options.correctionArtifactSha256)) {
            violations.push('Correction-only invocation was not launched from the persisted correction package.');
        }
        if (
            invocationEvidence?.delegation_started_event_type !== 'REVIEWER_DELEGATION_STARTED'
            || !normalizeSha256(invocationEvidence.delegation_started_event_sha256)
        ) {
            violations.push('Correction-only invocation lacks an independently persisted delegation-start event.');
        }
        if (invocationEvidence?.delegation_started_reviewer_identity !== producer.producer_identity) {
            violations.push('Correction-only delegation identity does not match the correction producer.');
        }
        if (invocationEvidence?.delegation_started_provider_invocation_id !== producer.provider_invocation_id) {
            violations.push('Correction-only delegation provider invocation does not match the correction producer.');
        }
        if (!normalizeSha256(invocationEvidence?.correction_launch_artifact_sha256)) {
            violations.push('Correction-only invocation lacks a gate-owned launch artifact binding.');
        }
    }
    if (options.artifact.recovery.correction_attempt > options.artifact.recovery.max_correction_attempts) {
        violations.push('Bounded review output correction attempts are exhausted.');
    }
    const correctedFingerprint = computeReviewFindingsSemanticFingerprint(options.correctedOutput);
    if (!binding.findings_semantic_fingerprint) {
        violations.push(MISSING_FINDINGS_FINGERPRINT_REASON);
    } else if (correctedFingerprint !== binding.findings_semantic_fingerprint) {
        violations.push('Corrected output changed the semantic findings fingerprint.');
    }
    return {
        valid: violations.length === 0,
        requires_full_review: violations.length > 0,
        violations
    };
}

export async function executeReviewOutputCorrectionWithAdapter(options: {
    artifact: ReviewOutputCorrectionArtifact;
    adapter: ReviewOutputCorrectionTransportAdapter;
}): Promise<string> {
    const transport = resolveReviewOutputCorrectionTransport({
        diagnostics: options.artifact.diagnostics,
        capabilities: options.adapter.capabilities,
        correctionAttempt: options.artifact.recovery.correction_attempt,
        maxCorrectionAttempts: options.artifact.recovery.max_correction_attempts,
        forceFullReviewReasons: options.artifact.state === 'FULL_REVIEW_REQUIRED'
            ? [options.artifact.recovery.reason]
            : []
    }).transport;
    if (transport === 'live_reviewer_continuation' && options.adapter.continueReview) {
        return options.adapter.continueReview(options.artifact);
    }
    if (transport === 'api_conversation_continuation' && options.adapter.continueApiConversation) {
        return options.adapter.continueApiConversation(options.artifact);
    }
    if (transport === 'correction_only_invocation' && options.adapter.invokeCorrectionOnly) {
        return options.adapter.invokeCorrectionOnly(options.artifact);
    }
    throw new Error(`Correction adapter '${options.adapter.id}' cannot execute selected transport '${transport}'.`);
}
