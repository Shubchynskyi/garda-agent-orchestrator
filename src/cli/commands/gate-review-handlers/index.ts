import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    normalizeCompatibilityReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../../gate-runtime/review-context';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
} from '../../../gate-runtime/reviewer-session-contract';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../gate-runtime/task-events';
import { fileSha256 } from '../../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync,
    emitReviewerLaunchPreparedEventAsync,
    emitReviewerInvocationAttestedEventAsync,
    emitReviewRecordedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import {
    captureReviewArtifactRollbackState,
    restoreReviewArtifactFromRollbackState,
    writeReviewArtifactJson,
    writeReviewArtifactText,
    writeReviewArtifactsWithRollback
} from '../../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { REVIEW_CONTRACTS } from '../../../gates/required-reviews-check';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../../gates/review-dependencies';
import {
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    computeReviewContextReuseHash,
    isNonTestReviewScope
} from '../../../gates/review-reuse';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../../../gates/review-context-contract';
import {
    assertReviewTreeStateFresh
} from '../../../gates/review-tree-state';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../gates/review-prompt-artifact';
import {
    resolveLegacyReviewTempRoot,
    resolveDefaultReviewScratchPath,
    resolveReviewScratchRoot
} from '../../../gates/review-scratch-paths';
import { resolveReviewContextRoutingIdentity } from '../../../gates/review-context-routing';
import { assertReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import { normalizeRuntimeIdentitySource, resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import { getProviderEntryById } from '../../../core/provider-registry';
import {
    extractMarkdownSectionLines,
    getCanonicalReviewSectionHeading,
    getReviewArtifactFindingsEvidence,
    isTrivialReview,
    normalizeCanonicalReviewSectionHeadings
} from '../../../gates/completion';
import {
    cleanupReviewTempSourceArtifact,
    isTaskOwnedReviewTempPath
} from '../gates-artifacts';
import {
    parseOptions,
    normalizePathValue
} from '../cli-helpers';
import {
    type ParsedOptionsRecord,
    removeArtifactIfExists
} from '../shared-command-utils';

interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

interface ParsedReviewerIdentity {
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

interface ResolvedReviewOutputInput {
    reviewContent: string;
    reviewOutputPath: string;
    reviewOutputMode: 'path' | 'stdin';
    reviewOutputSourcePath: string | null;
}

interface ReviewerLaunchArtifactValidationResult {
    artifactPath: string;
    artifactSha256: string;
    attestationSource: string;
    launchTool: string;
    providerInvocationId: string;
    launchedAtUtc: string;
}

const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';
const PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE = 'garda_prepare_reviewer_launch';
const FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES = new Set([
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    'orchestrator_mock',
    'mock',
    'manual'
]);
const UTC_ISO_8601_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY = (
    'Local reviewer launch artifacts are convenience metadata for a real delegated reviewer launch; ' +
    'they are not non-forgeable proof without provider-owned recording.'
);
const REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS = Object.freeze([
    "evidence_type='delegated_reviewer_launch'",
    "attestation_state='launched'",
    'attestation_source=<provider/controller source, not garda_prepare_reviewer_launch/manual/mock>',
    'provider_invocation_id or controller_invocation_id=<actual delegated reviewer invocation id>',
    'launched_at_utc=<ISO-8601 launch timestamp>',
    'fresh_context=true, isolated_context=true, or fork_context=false'
]);

function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeReviewerLaunchAttestationSource(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function isForbiddenReviewerLaunchAttestationSource(value: string): boolean {
    return FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES.has(
        normalizeReviewerLaunchAttestationSource(value)
    );
}

function isValidUtcIso8601Timestamp(value: string): boolean {
    const match = UTC_ISO_8601_TIMESTAMP_PATTERN.exec(value);
    if (!match) {
        return false;
    }
    const timestampMs = Date.parse(value);
    if (!Number.isFinite(timestampMs)) {
        return false;
    }
    const parsed = new Date(timestampMs);
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() + 1 === month
        && parsed.getUTCDate() === day
        && parsed.getUTCHours() === hour
        && parsed.getUTCMinutes() === minute
        && parsed.getUTCSeconds() === second;
}

function buildReviewerLaunchBindingSha256(options: {
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
}): string {
    return stringSha256([
        `task_id=${options.taskId}`,
        `review_type=${options.reviewType}`,
        `reviewer_execution_mode=${options.reviewerExecutionMode}`,
        `reviewer_identity=${options.reviewerIdentity}`,
        `review_context_sha256=${options.reviewContextSha256}`,
        `routing_event_sha256=${options.routingEventSha256}`,
        `reviewer_prompt_sha256=${options.reviewerPromptSha256 || ''}`
    ].join('\n'));
}

function quoteReviewerLaunchCommandValue(value: string): string {
    return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function toRepoRelativeCommandPath(repoRoot: string, artifactPath: string): string {
    const relativePath = path.relative(repoRoot, artifactPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return normalizePath(artifactPath);
    }
    return normalizePath(relativePath);
}

function buildRecordReviewInvocationCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewerLaunchArtifactPath: string;
}): string {
    const commandParts = [
        'node bin/garda.js gate record-review-invocation',
        '--task-id', quoteReviewerLaunchCommandValue(options.taskId),
        '--review-type', quoteReviewerLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteReviewerLaunchCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteReviewerLaunchCommandValue(options.reviewerIdentity),
        '--reviewer-launch-artifact-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewerLaunchArtifactPath)),
        '--repo-root', quoteReviewerLaunchCommandValue('.')
    ];
    return commandParts.join(' ');
}

function buildReviewerLaunchCompletionHint(): string {
    return [
        'Completion hint:',
        '- Start from the prepared reviewer-launch artifact; do not search for or recompute its hashes.',
        `- Required completed-launch updates: ${REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS.join('; ')}.`,
        `- Trust boundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`
    ].join('\n');
}

function resolveCanonicalReviewPaths(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    preflightPathValue: unknown,
    reviewContextPathValue: unknown
): ResolvedCanonicalReviewPaths {
    const canonicalPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    assertArtifactPathRealpathInsideRepo(repoRoot, canonicalPreflightPath, 'PreflightPath');
    const resolvedPreflightPath = gateHelpers.resolvePathInsideRepo(String(preflightPathValue || ''), repoRoot, { allowMissing: true });
    if (!resolvedPreflightPath) {
        throw new Error('PreflightPath is required.');
    }
    assertArtifactPathRealpathInsideRepo(repoRoot, resolvedPreflightPath, 'PreflightPath');
    if (resolvedPreflightPath !== canonicalPreflightPath) {
        throw new Error(
            `PreflightPath must point to the canonical preflight artifact for '${taskId}': ` +
            `${normalizePath(canonicalPreflightPath)}.`
        );
    }
    const preflightPath = resolvedPreflightPath;
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }

    const reviewsRoot = path.dirname(preflightPath);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: reviewContextPathValue ? String(reviewContextPathValue) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    return {
        preflightPath,
        reviewsRoot,
        artifactPath,
        contextPath
    };
}

function assertArtifactPathRealpathInsideRepo(repoRoot: string, artifactPath: string, label: string): void {
    if (!gateHelpers.isPathRealpathInsideRoot(artifactPath, repoRoot)) {
        throw new Error(
            `${label} must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(artifactPath)}.`
        );
    }
}

function resolveCanonicalPreflightArtifactPath(repoRoot: string, taskId: string): string {
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
    assertArtifactPathRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${normalizePath(preflightPath)}.`);
    }
    return preflightPath;
}

function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;

    if (!reviewerExecutionMode) {
        if (rawReviewerExecutionMode) {
            throw new Error(
                `ReviewerExecutionMode '${rawReviewerExecutionMode}' is invalid. ` +
                "Expected 'delegated_subagent'."
            );
        }
        throw new Error(modeRequiredMessage);
    }
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `ReviewerExecutionMode '${reviewerExecutionMode}' is no longer supported. ` +
            "Mandatory reviews must use 'delegated_subagent'."
        );
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerIdentity.startsWith('self:')) {
        throw new Error('Delegated review evidence cannot use a self-scoped reviewer identity.');
    }
    if (!reviewerIdentity.startsWith('agent:')) {
        throw new Error("Delegated review evidence requires an agent-scoped reviewer identity (prefix 'agent:').");
    }
    if (reviewerFallbackReason) {
        throw new Error(
            'ReviewerFallbackReason is not supported for delegated_subagent review evidence. ' +
            'Remove --reviewer-fallback-reason and rerun the delegated reviewer flow.'
        );
    }

    return {
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    };
}

function getCanonicalReviewOutputArtifactPath(reviewsRoot: string, taskId: string, reviewType: string): string {
    return path.join(reviewsRoot, `${taskId}-${reviewType}-review-output.md`);
}

export { handleRequiredReviewsCheck, handleDocImpactGate } from './simple-handlers';

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

async function resolveReviewOutputInput(
    options: ParsedOptionsRecord,
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    reviewType: string
): Promise<ResolvedReviewOutputInput> {
    const useReviewOutputStdin = options.reviewOutputStdin === true;
    const rawReviewOutputPath = String(options.reviewOutputPath || '').trim();
    const hasReviewOutputPath = rawReviewOutputPath.length > 0;
    if (useReviewOutputStdin === hasReviewOutputPath) {
        throw new Error(
            "Review output requires exactly one input source. Provide either '--review-output-path' or '--review-output-stdin'."
        );
    }

    const reviewOutputArtifactPath = getCanonicalReviewOutputArtifactPath(reviewsRoot, taskId, reviewType);
    let reviewContent = '';
    let reviewOutputSourcePath: string | null = null;
    if (useReviewOutputStdin) {
        reviewContent = await readReviewOutputFromStdin();
    } else {
        const resolvedReviewOutputPath = gateHelpers.resolvePathInsideRepo(rawReviewOutputPath, repoRoot, { allowMissing: true });
        if (!resolvedReviewOutputPath) {
            throw new Error('ReviewOutputPath is required.');
        }
        if (!fs.existsSync(resolvedReviewOutputPath) || !fs.statSync(resolvedReviewOutputPath).isFile()) {
            throw new Error(`Review output not found: ${normalizePath(resolvedReviewOutputPath)}.`);
        }
        if (!gateHelpers.isPathRealpathInsideRoot(resolvedReviewOutputPath, repoRoot)) {
            throw new Error(
                `ReviewOutputPath must resolve inside repo root without symlink or junction escape: ` +
                `${normalizePath(resolvedReviewOutputPath)}.`
            );
        }
        const lexicalReviewOutputPath = path.resolve(resolvedReviewOutputPath);
        const realReviewOutputPath = fs.realpathSync(resolvedReviewOutputPath);
        if (
            gateHelpers.normalizePath(lexicalReviewOutputPath).toLowerCase()
            !== gateHelpers.normalizePath(realReviewOutputPath).toLowerCase()
        ) {
            throw new Error(
                `ReviewOutputPath must not traverse symlinks or junctions: ` +
                `${normalizePath(resolvedReviewOutputPath)}.`
            );
        }
        const relativeReviewTempPath = path.relative(resolveReviewScratchRoot(repoRoot), resolvedReviewOutputPath);
        const isInsideReviewTemp = relativeReviewTempPath.length > 0
            && !relativeReviewTempPath.startsWith('..')
            && !path.isAbsolute(relativeReviewTempPath);
        if (isInsideReviewTemp
            && !isTaskOwnedReviewTempPath(repoRoot, taskId, resolvedReviewOutputPath)) {
            throw new Error(
                `ReviewOutputPath inside reviewer scratch storage must encode the current task id '${taskId}' ` +
                `so cleanup can attribute it safely. Use ` +
                `'garda-agent-orchestrator/runtime/tmp/reviews/${taskId}/${reviewType}/review-output.md'.`
            );
        }
        const relativeLegacyReviewTempPath = path.relative(resolveLegacyReviewTempRoot(repoRoot), resolvedReviewOutputPath);
        const isInsideLegacyReviewTemp = relativeLegacyReviewTempPath.length > 0
            && !relativeLegacyReviewTempPath.startsWith('..')
            && !path.isAbsolute(relativeLegacyReviewTempPath);
        if (isInsideLegacyReviewTemp) {
            throw new Error(
                `ReviewOutputPath must not use legacy '.review-temp'. Use ` +
                `'garda-agent-orchestrator/runtime/tmp/reviews/${taskId}/${reviewType}/review-output.md'.`
            );
        }
        reviewOutputSourcePath = resolvedReviewOutputPath;
        reviewContent = fs.readFileSync(resolvedReviewOutputPath, 'utf8');
    }

    // Persist raw reviewer input before verdict extraction so direct ingest cannot bypass the audited file path.
    writeReviewArtifactText(reviewOutputArtifactPath, reviewContent);
    if (!reviewContent.trim()) {
        throw new Error(`Review output is empty: ${normalizePath(reviewOutputArtifactPath)}.`);
    }

    return {
        reviewContent,
        reviewOutputPath: reviewOutputArtifactPath,
        reviewOutputMode: useReviewOutputStdin ? 'stdin' : 'path',
        reviewOutputSourcePath: reviewOutputSourcePath && normalizePath(reviewOutputSourcePath) !== normalizePath(reviewOutputArtifactPath)
            ? reviewOutputSourcePath
            : null
    };
}

function getReviewHeading(reviewType: string): string {
    const normalized = String(reviewType || '').trim().toLowerCase();
    switch (normalized) {
        case 'api':
            return 'API Review';
        case 'db':
            return 'DB Review';
        case 'infra':
            return 'Infra Review';
        case 'security':
            return 'Security Review';
        case 'refactor':
            return 'Refactor Review';
        case 'performance':
            return 'Performance Review';
        case 'dependency':
            return 'Dependency Review';
        case 'test':
            return 'Test Review';
        case 'code':
        default:
            return 'Code Review';
    }
}

function buildMinimalPassReviewTemplateHint(reviewType: string, expectedPassVerdict: string): string {
    return [
        'Minimal compliant PASS review template for a no-findings review (structure only; substantive analysis is still required):',
        `# ${getReviewHeading(reviewType)}`,
        'Validated the relevant files with concrete scope notes, file references, and enough detail to exceed the trivial-review filter.',
        '## Findings by Severity',
        'none',
        '## Deferred Findings',
        'none',
        '## Residual Risks',
        'none',
        '## Verdict',
        expectedPassVerdict,
        "If accepted non-blocking follow-up remains, move it to '## Deferred Findings' and include 'Justification:' for every deferred entry."
    ].join('\n');
}

type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

function analyzeEarlyReviewMaterialization(options: {
    artifactPath: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
}): { violations: string[]; findingsEvidence: ReviewFindingsEvidence } {
    const { artifactPath, reviewContent, verdictToken, expectedPassVerdict } = options;
    const violations: string[] = [];
    const normalizedArtifactPath = normalizePath(artifactPath);
    if (isTrivialReview(reviewContent)) {
        violations.push(
            `Review artifact '${normalizedArtifactPath}' is trivial or obviously synthetic. ` +
            'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
        );
    }

    const findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, reviewContent);
    const requireCleanPassArtifact = verdictToken === expectedPassVerdict;
    const passOnlyActiveViolations = new Set<string>();
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (findingsEvidence.findings_by_severity[severity].length === 0) {
            continue;
        }
        const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
        passOnlyActiveViolations.add(
            `Review artifact '${normalizedArtifactPath}' still contains active ${severityLabel} findings. ` +
            "Resolve them or move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:'."
        );
    }
    if (findingsEvidence.residual_risks.length > 0) {
        passOnlyActiveViolations.add(
            `Review artifact '${normalizedArtifactPath}' still contains active residual risks. ` +
            "Move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:' before DONE."
        );
    }
    for (const violation of findingsEvidence.violations) {
        // Every recorded review must remain structurally auditable. Only the
        // "clean pass" requirement is verdict-specific; failed reviews still
        // materialize with active findings when the lifecycle sections exist.
        if (!passOnlyActiveViolations.has(violation) || requireCleanPassArtifact) {
            violations.push(violation);
        }
    }

    return {
        violations,
        findingsEvidence
    };
}

function hasMarkdownHeading(reviewContent: string, heading: string): boolean {
    return String(reviewContent || '')
        .split('\n')
        .some((rawLine) => {
            const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(rawLine.trim());
            const canonicalHeading = getCanonicalReviewSectionHeading(rawLine);
            return canonicalHeading
                ? canonicalHeading.toLowerCase() === heading.trim().toLowerCase()
                : !!headingMatch && headingMatch[2].trim().toLowerCase() === heading.trim().toLowerCase();
        });
}

function buildNoFindingsPassReviewRecoveryHint(options: {
    reviewContent: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    const { reviewContent, findingsEvidence } = options;
    const activeFindingsCount = Object.values(findingsEvidence.findings_by_severity)
        .reduce((total, entries) => total + entries.length, 0);
    if (activeFindingsCount > 0) {
        return null;
    }

    const hintLines: string[] = [];
    const findingsSectionPresent = hasMarkdownHeading(reviewContent, 'Findings by Severity');
    const residualSectionPresent = hasMarkdownHeading(reviewContent, 'Residual Risks');
    const deferredSectionPresent = hasMarkdownHeading(reviewContent, 'Deferred Findings');
    const deferredSectionLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Deferred Findings');
    const deferredSectionLooksEmpty = deferredSectionPresent
        && deferredSectionLines.length > 0
        && findingsEvidence.deferred_findings.length === 0
        && findingsEvidence.invalid_deferred_findings.length === 0;

    if (findingsEvidence.missing_sections.includes('Findings by Severity')) {
        hintLines.push(findingsSectionPresent
            ? "Set '## Findings by Severity' explicitly to 'none' when no findings remain open."
            : "Add mandatory section '## Findings by Severity' and set it to 'none' when no findings remain open.");
    }
    if (findingsEvidence.residual_risks.length > 0) {
        hintLines.push(
            "'## Residual Risks' is only for active open risks. For a PASS review with no open risks, set it to 'none' and move accepted follow-up to '## Deferred Findings' with 'Justification:'."
        );
    } else if (findingsEvidence.missing_sections.includes('Residual Risks')) {
        hintLines.push(residualSectionPresent
            ? "Set '## Residual Risks' explicitly to 'none' when no active risks remain."
            : "Add mandatory section '## Residual Risks' and set it to 'none' when no active risks remain.");
    }
    if (findingsEvidence.invalid_deferred_findings.length > 0) {
        hintLines.push(
            "Every '## Deferred Findings' entry must include 'Justification:'. If nothing is deferred, remove that section or set it to 'none'."
        );
    } else if (deferredSectionLooksEmpty) {
        hintLines.push(
            "'## Deferred Findings' may be omitted, but if you keep it for a no-findings PASS review, set it explicitly to 'none'."
        );
    }

    if (hintLines.length === 0) {
        return null;
    }
    return [
        'No-findings PASS review recovery:',
        ...hintLines.map((line) => `- ${line}`)
    ].join('\n');
}

function buildPassReviewTemplateHintMessage(options: {
    reviewType: string;
    verdictToken: string;
    expectedPassVerdict: string;
    reviewContent: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    if (options.verdictToken !== options.expectedPassVerdict) {
        return null;
    }
    const targetedHint = buildNoFindingsPassReviewRecoveryHint({
        reviewContent: options.reviewContent,
        findingsEvidence: options.findingsEvidence
    });
    const templateHint = buildMinimalPassReviewTemplateHint(options.reviewType, options.expectedPassVerdict);
    return targetedHint ? `${targetedHint}\n\n${templateHint}` : templateHint;
}

const CANONICAL_REVIEW_SECTION_HEADINGS = new Set([
    'findings by severity',
    'deferred findings',
    'residual risks',
    'verdict'
]);

function trimBlankLineEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim().length === 0) {
        start += 1;
    }
    while (end > start && lines[end - 1].trim().length === 0) {
        end -= 1;
    }
    return lines.slice(start, end);
}

function stripMarkdownListPrefix(entry: string): string {
    return String(entry || '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .trim();
}

function extractReviewPreambleLines(reviewType: string, reviewContent: string): string[] {
    const lines = String(reviewContent || '').split('\n');
    const preamble: string[] = [];
    for (const line of lines) {
        const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
        const canonicalHeading = getCanonicalReviewSectionHeading(line);
        if (canonicalHeading || (headingMatch && CANONICAL_REVIEW_SECTION_HEADINGS.has(headingMatch[2].trim().toLowerCase()))) {
            break;
        }
        preamble.push(line);
    }
    const trimmed = trimBlankLineEdges(preamble);
    if (trimmed.length > 0) {
        return trimmed;
    }
    return [`# ${getReviewHeading(reviewType)}`];
}

function appendDeferredFinding(lines: string[], entry: string): void {
    const normalizedEntry = stripMarkdownListPrefix(entry);
    if (!normalizedEntry) {
        return;
    }
    lines.push(`- ${normalizedEntry}`);
    lines.push('  Justification: Preserved from raw reviewer output during PASS review normalization.');
    lines.push('');
}

function appendPreservedRawReviewerOutput(lines: string[], reviewContent: string): void {
    lines.push('## Preserved Raw Reviewer Output');
    lines.push('');
    for (const line of String(reviewContent || '').replace(/\r\n/g, '\n').split('\n')) {
        lines.push(line.length > 0 ? `> ${line}` : '>');
    }
    lines.push('');
}

function isLosslessPassNormalizationEligibleViolation(violation: string): boolean {
    const normalizedViolation = String(violation || '').toLowerCase();
    return normalizedViolation.includes('still contains active ')
        || normalizedViolation.includes("deferred finding without usable 'justification:'");
}

function buildLosslessPassReviewNormalization(options: {
    reviewType: string;
    reviewContent: string;
    expectedPassVerdict: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    const {
        reviewType,
        reviewContent,
        expectedPassVerdict,
        findingsEvidence
    } = options;
    const activeFindings = (['critical', 'high', 'medium', 'low'] as const)
        .flatMap((severity) => findingsEvidence.findings_by_severity[severity].map((entry) => `[${severity}] ${entry}`));
    const activeResidualRisks = findingsEvidence.residual_risks.map((entry) => `[follow-up] ${entry}`);
    const pendingDeferredEntries = [
        ...findingsEvidence.deferred_findings,
        ...findingsEvidence.invalid_deferred_findings,
        ...activeFindings,
        ...activeResidualRisks
    ];
    if (pendingDeferredEntries.length === 0) {
        return null;
    }

    const normalizedLines = [...extractReviewPreambleLines(reviewType, reviewContent)];
    if (normalizedLines.length === 0 || !normalizedLines[0].trim().startsWith('#')) {
        normalizedLines.unshift(`# ${getReviewHeading(reviewType)}`);
    }
    if (normalizedLines[normalizedLines.length - 1]?.trim().length !== 0) {
        normalizedLines.push('');
    }
    appendPreservedRawReviewerOutput(normalizedLines, reviewContent);
    normalizedLines.push('## Findings by Severity');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Deferred Findings');
    normalizedLines.push('');
    for (const entry of pendingDeferredEntries) {
        appendDeferredFinding(normalizedLines, entry);
    }
    if (normalizedLines[normalizedLines.length - 1]?.trim().length === 0) {
        normalizedLines.pop();
    }
    normalizedLines.push('');
    normalizedLines.push('## Residual Risks');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Verdict');
    normalizedLines.push(expectedPassVerdict);
    return `${normalizedLines.join('\n')}\n`;
}

function assertRoutingCompatibility(
    options: {
        reviewType: string;
        runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>;
        currentRouting: Record<string, unknown> | null;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerFallbackReason: string | null;
    }
): void {
    const {
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    } = options;
    const capabilityLevel = runtimeIdentity.capability_level;
    const expectedExecutionMode = runtimeIdentity.expected_execution_mode;
    const fallbackAllowed = runtimeIdentity.fallback_allowed;
    const fallbackReasonRequired = runtimeIdentity.fallback_reason_required;
    const providerLabel = runtimeIdentity.execution_provider
        || runtimeIdentity.canonical_source_of_truth
        || String(currentRouting?.execution_provider || currentRouting?.source_of_truth || 'unknown');
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `Review '${reviewType}' must use delegated_subagent for provider '${providerLabel}'.`
        );
    }
    if (capabilityLevel !== 'delegation_required' && capabilityLevel !== 'unknown') {
        throw new Error(
            `Review '${reviewType}' resolved unexpected reviewer capability '${capabilityLevel}' ` +
            `for provider '${providerLabel}'.`
        );
    }
    if (expectedExecutionMode !== 'delegated_subagent' || !runtimeIdentity.delegation_required) {
        throw new Error(
            `Review '${reviewType}' resolved a non-delegated reviewer routing policy for provider '${providerLabel}'. ` +
            'Mandatory reviews require delegated_subagent execution.'
        );
    }
    if (fallbackAllowed || fallbackReasonRequired || reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' encountered stale fallback routing metadata for provider '${providerLabel}'. ` +
            'Mandatory reviews do not permit same_agent_fallback.'
        );
    }
}

function assertReviewContextContractOrThrow(options: {
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    preflightPayload?: Record<string, unknown> | null;
    requireStrictBindingMetadata?: boolean;
}): void {
    const diffExpectations = buildReviewContextPreflightDiffExpectations(options.preflightPayload, options.reviewType);
    const requireStrictBindingMetadata = options.requireStrictBindingMetadata === true
        || diffExpectations.expectedRequiredReview === true;
    const violations = getReviewContextContractViolations({
        contextPath: options.contextPath,
        reviewContext: options.reviewContext,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: true,
        requireTaskId: requireStrictBindingMetadata,
        requirePreflightPath: requireStrictBindingMetadata,
        requirePreflightSha256: requireStrictBindingMetadata,
        ...diffExpectations
    });
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

function assertExplicitReviewContextRuntimeIdentity(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewerRouting: Record<string, unknown> | null;
    taskModePath?: string | null;
}): ReturnType<typeof resolveRuntimeReviewerIdentity> {
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        taskModePath: String(options.taskModePath || '').trim(),
        allowLegacyFallback: true
    });
    if (runtimeIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because runtime reviewer identity is ` +
            `'${runtimeIdentity.identity_status}'.`
        );
    }
    if (runtimeIdentity.violations.length > 0) {
        throw new Error(runtimeIdentity.violations.join(' '));
    }
    const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
        reviewerRouting: options.reviewerRouting,
        canonicalSourceOfTruth: runtimeIdentity.canonical_source_of_truth,
        executionProvider: runtimeIdentity.execution_provider,
        allowLegacyCompatibility: runtimeIdentity.task_mode_identity_backfilled
    });
    const reviewContextExecutionProviderSource = normalizeRuntimeIdentitySource(options.reviewerRouting?.execution_provider_source);
    if (!runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active workspace is missing canonical SourceOfTruth.`
        );
    }
    if (!resolvedRoutingIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing canonical_source_of_truth in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.canonical_source_of_truth !== runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context canonical_source_of_truth ` +
            `(${resolvedRoutingIdentity.canonical_source_of_truth}) does not match canonical provider ` +
            `(${runtimeIdentity.canonical_source_of_truth}).`
        );
    }
    if (!runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active task is missing execution provider identity.`
        );
    }
    if (!resolvedRoutingIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.execution_provider !== runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider ` +
            `(${resolvedRoutingIdentity.execution_provider}) does not match active runtime provider ` +
            `(${runtimeIdentity.execution_provider}).`
        );
    }
    if (resolvedRoutingIdentity.explicit_split_identity_present && !reviewContextExecutionProviderSource) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider_source in ${normalizePath(options.contextPath)}.`
        );
    }
    if (
        resolvedRoutingIdentity.explicit_split_identity_present
        && runtimeIdentity.execution_provider_source
        && reviewContextExecutionProviderSource !== runtimeIdentity.execution_provider_source
    ) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider_source ` +
            `(${reviewContextExecutionProviderSource}) does not match active runtime source ` +
            `(${runtimeIdentity.execution_provider_source}).`
        );
    }
    if (!resolvedRoutingIdentity.identity_status) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing identity_status in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' review-context runtime identity status must be 'resolved', ` +
            `got '${resolvedRoutingIdentity.identity_status}'.`
        );
    }
    return runtimeIdentity;
}

function matchesRoutingEvent(
    entry: ReviewDependencyTimelineEvent,
    reviewType: string,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): boolean {
    const details = entry.details;
    return entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
        && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
        && !reviewerFallbackReason;
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

function findMatchingRoutingEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    const cycleFloorSequence = latestCompilePassSequence == null
        ? latestReviewPhaseSequence
        : latestReviewPhaseSequence == null
            ? latestCompilePassSequence
            : Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
    if (cycleFloorSequence == null) {
        return null;
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (entry.sequence <= cycleFloorSequence) {
            break;
        }
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && matchesRoutingEvent(
                entry,
                normalizedReviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewerFallbackReason
            )
        ) {
            return entry;
        }
    }
    return null;
}

function findMatchingReviewerInvocationAttestationEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerIdentity: string;
        reviewContextSha256: string;
        reviewTreeStateSha256?: string | null;
        routingEventSha256: string;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedReviewTreeStateSha256 = String(options.reviewTreeStateSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewTreeStateSha256 = String(details?.review_tree_state_sha256 || details?.reviewTreeStateSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && detailsReviewerIdentity === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && (!normalizedReviewTreeStateSha256 || detailsReviewTreeStateSha256 === normalizedReviewTreeStateSha256)
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && entry.integrity
        ) {
            return entry;
        }
    }
    return null;
}

function findMatchingReviewerLaunchPreparedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    const normalizedLaunchBindingSha256 = String(options.launchBindingSha256 || '').trim().toLowerCase();
    const normalizedPreparedLaunchEventSha256 = String(options.preparedLaunchEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsLaunchBindingSha256 = String(details?.launch_binding_sha256 || details?.launchBindingSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_LAUNCH_PREPARED'
            && entry.sequence > options.minSequenceExclusive
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && detailsReviewerIdentity === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && detailsLaunchBindingSha256 === normalizedLaunchBindingSha256
            && entry.integrity?.event_sha256 === normalizedPreparedLaunchEventSha256
        ) {
            return entry;
        }
    }
    return null;
}

function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`${label} must contain a JSON object.`);
        }
        return parsed as Record<string, unknown>;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`${label} must contain valid JSON: ${error.message}`);
        }
        throw error;
    }
}

function readJsonObjectIfPresent(pathValue: string): Record<string, unknown> | null {
    if (!fs.existsSync(pathValue) || !fs.statSync(pathValue).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (value == null) {
            continue;
        }
        const text = String(value).trim();
        if (text) {
            return text;
        }
    }
    return '';
}

function resolveDefaultReviewerLaunchArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    return resolveDefaultReviewScratchPath(repoRoot, taskId, reviewType, 'reviewer-launch.json');
}

function resolveReviewerLaunchArtifactPathForWrite(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPathValue: unknown;
}): string {
    const rawArtifactPath = String(options.artifactPathValue || '').trim()
        || resolveDefaultReviewerLaunchArtifactPath(options.repoRoot, options.taskId, options.reviewType);
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath) {
        throw new Error('ReviewerLaunchArtifactPath could not be resolved.');
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }
    return artifactPath;
}

function getReviewTreeStateSha256(reviewContext: Record<string, unknown>): string {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    return treeState
        ? getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase()
        : '';
}

function getReviewTreeStateLaunchSummary(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    if (!treeState) {
        return null;
    }
    return {
        tree_state_sha256: getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase(),
        detection_source: getStringField(treeState, 'detection_source', 'detectionSource'),
        use_staged: treeState.use_staged === true,
        include_untracked: treeState.include_untracked === true,
        changed_files: Array.isArray(treeState.changed_files) ? treeState.changed_files : [],
        stale_staged_snapshot_files: Array.isArray(treeState.stale_staged_snapshot_files)
            ? treeState.stale_staged_snapshot_files
            : []
    };
}

function resolveProviderLaunchMetadata(runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>): {
    provider: string | null;
    launchTool: string;
    launchInstruction: string;
} {
    const provider = runtimeIdentity.execution_provider || runtimeIdentity.canonical_source_of_truth || null;
    const providerEntry = provider ? getProviderEntryById(provider) : null;
    return {
        provider,
        launchTool: providerEntry?.reviewerLaunchLabel || provider || 'delegated_subagent',
        launchInstruction: providerEntry?.delegatedReviewerLaunchInstruction
            || 'launch a clean-context reviewer sub-agent with isolated context.'
    };
}

function assertPreparedReviewerLaunchArtifact(options: {
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256?: string | null;
    reviewTreeStateSha256?: string | null;
}): void {
    const artifact = readJsonFile(options.artifactPath, 'Prepared reviewer launch artifact');
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const expectedLaunchBindingSha256 = options.reviewerPromptSha256
        ? buildReviewerLaunchBindingSha256({
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerPromptSha256: options.reviewerPromptSha256
        })
        : '';
    const violations: string[] = [];
    if (Number(artifact.schema_version) !== 1) {
        violations.push('schema_version must be 1');
    }
    if (getStringField(artifact, 'evidence_type', 'artifact_type') !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    if (getStringField(artifact, 'attestation_state', 'attestationState') !== 'prepared') {
        violations.push("attestation_state must be 'prepared'");
    }
    if (getStringField(artifact, 'task_id', 'taskId') !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    if (getStringField(artifact, 'reviewer_identity', 'reviewerIdentity', 'reviewer_session_id', 'reviewerSessionId') !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (getStringField(artifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256) {
        const actualPromptSha256 = getStringField(
            artifact,
            'reviewer_prompt_sha256',
            'reviewerPromptSha256'
        ).toLowerCase();
        if (actualPromptSha256 !== options.reviewerPromptSha256) {
            violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
        }
    }
    if (options.reviewTreeStateSha256) {
        const actualTreeStateSha256 = getStringField(
            artifact,
            'review_tree_state_sha256',
            'reviewTreeStateSha256'
        ).toLowerCase();
        if (actualTreeStateSha256 !== options.reviewTreeStateSha256) {
            violations.push('review_tree_state_sha256 must match the current review context tree_state');
        }
    }
    if (getStringField(artifact, 'attestation_source', 'attestationSource', 'source') !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        violations.push(`attestation_source must be '${PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE}'`);
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (expectedLaunchBindingSha256 && launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!getStringField(artifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')) {
        violations.push('prepared_launch_event_sha256 is required');
    }
    if (violations.length > 0) {
        throw new Error(
            'Prepared reviewer launch artifact failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n')
        );
    }
}

function validateReviewerLaunchArtifact(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    artifactPathValue: unknown;
}): ReviewerLaunchArtifactValidationResult {
    const rawArtifactPath = String(options.artifactPathValue || '').trim();
    if (!rawArtifactPath) {
        throw new Error('ReviewerLaunchArtifactPath is required.');
    }
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`Reviewer launch artifact not found: ${normalizePath(rawArtifactPath)}.`);
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }

    const artifact = readJsonFile(artifactPath, 'ReviewerLaunchArtifactPath');
    const schemaVersion = Number(artifact.schema_version);
    const evidenceType = String(artifact.evidence_type || artifact.artifact_type || '').trim();
    const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
    const reviewType = String(artifact.review_type || artifact.reviewType || '').trim().toLowerCase();
    const taskId = String(artifact.task_id || artifact.taskId || '').trim();
    const reviewerExecutionMode = String(
        artifact.reviewer_execution_mode || artifact.reviewerExecutionMode || ''
    ).trim();
    const reviewerIdentity = String(
        artifact.reviewer_identity || artifact.reviewerIdentity || artifact.reviewer_session_id || artifact.reviewerSessionId || ''
    ).trim();
    const reviewContextSha256 = String(
        artifact.review_context_sha256 || artifact.reviewContextSha256 || ''
    ).trim().toLowerCase();
    const routingEventSha256 = String(
        artifact.routing_event_sha256 || artifact.routingEventSha256 || ''
    ).trim().toLowerCase();
    const attestationSource = normalizeReviewerLaunchAttestationSource(
        artifact.attestation_source || artifact.attestationSource || artifact.source || ''
    );
    const launchTool = String(artifact.launch_tool || artifact.launchTool || '').trim();
    const providerInvocationId = getStringField(
        artifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const launchedAtUtc = getStringField(artifact, 'launched_at_utc', 'launchedAtUtc');
    const preparedLaunchEventSha256 = getStringField(
        artifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const reviewerPromptSha256 = getStringField(artifact, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase();
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const reviewTreeStateSha256 = getStringField(
        artifact,
        'review_tree_state_sha256',
        'reviewTreeStateSha256'
    ).toLowerCase();
    const expectedLaunchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: options.reviewerPromptSha256 || reviewerPromptSha256 || null
    });
    const freshContext = artifact.fresh_context === true
        || artifact.freshContext === true
        || artifact.isolated_context === true
        || artifact.isolatedContext === true
        || artifact.fork_context === false
        || artifact.forkContext === false;
    const violations: string[] = [];
    if (schemaVersion !== 1) {
        violations.push("schema_version must be 1");
    }
    if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE || attestationState === 'prepared') {
        violations.push(
            'prepared reviewer launch metadata cannot satisfy REVIEWER_INVOCATION_ATTESTED; ' +
            'launch a real delegated reviewer and persist provider/controller invocation evidence first'
        );
    }
    if (evidenceType !== COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    if (attestationState !== 'launched') {
        violations.push("attestation_state must be 'launched'");
    }
    if (taskId !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (reviewType !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (reviewerExecutionMode !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    if (reviewerIdentity !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (reviewContextSha256 !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (routingEventSha256 !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256 && reviewerPromptSha256 !== options.reviewerPromptSha256) {
        violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
    }
    if (options.reviewTreeStateSha256 && reviewTreeStateSha256 !== options.reviewTreeStateSha256) {
        violations.push('review_tree_state_sha256 must match the current review context tree_state');
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!preparedLaunchEventSha256) {
        violations.push('prepared_launch_event_sha256 is required');
    } else if (!/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)) {
        violations.push('prepared_launch_event_sha256 must be a lowercase sha256 hex digest');
    } else if (
        !findMatchingReviewerLaunchPreparedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            launchBindingSha256: expectedLaunchBindingSha256,
            preparedLaunchEventSha256,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        violations.push('prepared_launch_event_sha256 must reference current REVIEWER_LAUNCH_PREPARED telemetry');
    }
    if (!freshContext) {
        violations.push('fresh_context, isolated_context, or fork_context=false must attest clean reviewer context');
    }
    if (!attestationSource) {
        violations.push('attestation_source is required');
    } else if (isForbiddenReviewerLaunchAttestationSource(attestationSource)) {
        violations.push('attestation_source must be provider/controller-owned completed launch evidence');
    }
    if (!launchTool) {
        violations.push('launch_tool is required');
    }
    if (!providerInvocationId) {
        violations.push('provider_invocation_id or controller_invocation_id is required');
    }
    if (!launchedAtUtc) {
        violations.push('launched_at_utc is required');
    } else if (!isValidUtcIso8601Timestamp(launchedAtUtc)) {
        violations.push('launched_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (violations.length > 0) {
        throw new Error(
            'Reviewer launch artifact is not eligible for invocation attestation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n') +
            '\n\n' +
            buildReviewerLaunchCompletionHint()
        );
    }

    return {
        artifactPath,
        artifactSha256: fileSha256(artifactPath) || '',
        attestationSource,
        launchTool,
        providerInvocationId,
        launchedAtUtc
    };
}

function readDependencyTimelineEvents(timelinePath: string): ReviewDependencyTimelineEvent[] {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    return fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line, sequence) => {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                    ? parsed.integrity as Record<string, unknown>
                    : null;
                const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                    ? rawIntegrity.task_sequence
                    : Number(rawIntegrity?.task_sequence);
                const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
                const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
                const prevEventSha256 = prevEventSha256Raw == null
                    ? null
                    : String(prevEventSha256Raw).trim().toLowerCase() || null;
                return [{
                    event_type: String(parsed.event_type || '').trim().toUpperCase(),
                    sequence,
                    details,
                    integrity: rawIntegrity
                        && Number.isInteger(taskSequence)
                        && taskSequence > 0
                        && /^[0-9a-f]{64}$/.test(eventSha256)
                        && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                        ? {
                            schema_version: typeof rawIntegrity.schema_version === 'number'
                                ? rawIntegrity.schema_version
                                : Number(rawIntegrity.schema_version) || 1,
                            task_sequence: taskSequence,
                            prev_event_sha256: prevEventSha256,
                            event_sha256: eventSha256
                        }
                        : null
                }];
            } catch {
                return [];
            }
        });
}

async function recordReviewReceiptFromArtifacts(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    artifactPath: string;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSha256?: string | null;
    reviewMaterializationFidelity?: string | null;
    taskModePath?: string | null;
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    requireStrictBindingMetadata?: boolean;
}): Promise<string> {
    if (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile()) {
        throw new Error(`Review artifact not found: ${options.artifactPath}`);
    }

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8'));
    const preflightSha256 = fileSha256(options.preflightPath);
    const artifactSha256 = fileSha256(options.artifactPath);
    const parsedReviewContext = JSON.parse(fs.readFileSync(options.contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        preflightPath: options.preflightPath,
        preflightSha256,
        preflightPayload: preflight as Record<string, unknown>,
        requireStrictBindingMetadata: options.requireStrictBindingMetadata
    });
    assertReviewTreeStateFresh({
        repoRoot: options.repoRoot,
        reviewContext: parsedReviewContext,
        contextPath: options.contextPath,
        gateName: 'record-review-receipt'
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-receipt'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType: options.reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerFallbackReason: options.reviewerFallbackReason
    });
    const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== options.reviewerExecutionMode) {
        throw new Error(
            `Review receipt execution mode (${options.reviewerExecutionMode}) must match pre-recorded ` +
            `reviewer_routing.actual_execution_mode (${currentExecutionMode || 'missing'}) in ${normalizePath(options.contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (!currentReviewerSessionId) {
        throw new Error(
            `Review receipts require pre-recorded reviewer_routing.reviewer_session_id in ${normalizePath(options.contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (currentReviewerSessionId !== options.reviewerIdentity) {
        throw new Error(
            `Review receipt reviewer identity (${options.reviewerIdentity}) must match pre-recorded ` +
            `reviewer_routing.reviewer_session_id (${currentReviewerSessionId}).`
        );
    }
    const currentFallbackReason = currentRouting?.fallback_reason != null
        ? String(currentRouting.fallback_reason).trim()
        : '';
    if (
        options.reviewerExecutionMode === 'delegated_subagent' &&
        currentFallbackReason !== (options.reviewerFallbackReason || '')
    ) {
        throw new Error(
            `Review receipt fallback reason (${options.reviewerFallbackReason || 'missing'}) must match pre-recorded ` +
            `reviewer_routing.fallback_reason (${currentFallbackReason || 'missing'}).`
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        options.reviewType,
        options.reviewerExecutionMode,
        options.reviewerIdentity,
        options.reviewerFallbackReason
    );
    if (!routingEvent) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${options.reviewType}' ` +
            'in the current cycle ' +
            `with reviewer '${options.reviewerIdentity}' and execution mode '${options.reviewerExecutionMode}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Review receipts require controller-attested reviewer_provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Matching routing telemetry is missing event integrity.'
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256) {
        throw new Error(`Review receipts require a hashable review-context artifact: ${normalizePath(options.contextPath)}.`);
    }
    const invocationEvent = findMatchingReviewerInvocationAttestationEvent(timelineEvents, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext) || null,
        routingEventSha256: routingEventProvenance.event_sha256
    });
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        invocationEvent?.event_type || '',
        invocationEvent?.integrity,
        invocationEvent?.details
    );
    if (options.reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
        throw new Error(
            `Review receipts require REVIEWER_INVOCATION_ATTESTED launch provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Run the real delegated reviewer launch path before recording reviewer output; local routing telemetry alone is not enough.'
        );
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight as Record<string, unknown>, options.repoRoot);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflight as Record<string, unknown>,
        options.repoRoot
    );
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256: preflight.metrics?.scope_sha256 || preflight.metrics?.changed_files_sha256 || null,
        reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
        codeScopeSha256: isNonTestReviewScope(options.reviewType)
            ? codeScopeFingerprint.code_scope_sha256
            : null,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext) || null,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED'
    });
    (receipt as unknown as Record<string, unknown>).review_output_path = options.rawReviewOutputPath
        ? normalizePath(options.rawReviewOutputPath)
        : null;
    (receipt as unknown as Record<string, unknown>).review_output_sha256 = options.rawReviewOutputSha256 || null;
    (receipt as unknown as Record<string, unknown>).review_materialization_fidelity = options.reviewMaterializationFidelity || 'exact';

    const receiptPayloadSha256 = createHash('sha256')
        .update(`${JSON.stringify(receipt, null, 2)}\n`)
        .digest('hex');
    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(/\.md$/, `-artifact-${artifactSha256}.md`);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    await writeReviewArtifactsWithRollback([
        {
            artifactPath: receiptPath,
            contentType: 'json',
            payload: receipt
        },
        {
            artifactPath: receiptSnapshotPath,
            contentType: 'json',
            payload: receipt
        },
        {
            artifactPath: artifactSnapshotPath,
            contentType: 'text',
            content: fs.readFileSync(options.artifactPath, 'utf8')
        }
    ], async () => {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...receipt,
            receipt_path: normalizePath(receiptPath),
            receipt_sha256: receiptPayloadSha256,
            receipt_snapshot_path: normalizePath(receiptSnapshotPath),
            receipt_snapshot_sha256: receiptPayloadSha256,
            review_artifact_path: normalizePath(options.artifactPath),
            review_artifact_snapshot_path: normalizePath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: normalizePath(options.contextPath)
        });
        if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    });
    return receiptPath;
}

export async function handleRecordReviewRouting(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase');
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (!reviewerExecutionMode) {
        throw new Error("ReviewerExecutionMode is required. Expected 'delegated_subagent'.");
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `ReviewerExecutionMode '${reviewerExecutionMode}' is no longer supported. ` +
            "Mandatory reviews must use 'delegated_subagent'."
        );
    }
    if (reviewerIdentity.startsWith('self:')) {
        throw new Error('Delegated review routing cannot use a self-scoped reviewer identity.');
    }
    if (!reviewerIdentity.startsWith('agent:')) {
        throw new Error("Delegated review routing requires an agent-scoped reviewer identity (prefix 'agent:').");
    }
    if (reviewerFallbackReason) {
        throw new Error(
            'ReviewerFallbackReason is not supported for delegated_subagent review routing. ' +
            'Remove --reviewer-fallback-reason and rerun the delegated reviewer flow.'
        );
    }
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });

    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-routing'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    let routingUpdate = {
        updated: false,
        contextSha256: null as string | null
    };
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    try {
        routingUpdate = applyReviewerRoutingMetadata(contextPath, {
            actualExecutionMode: reviewerExecutionMode,
            reviewerSessionId: reviewerIdentity,
            fallbackReason: reviewerFallbackReason
        });
        const routedEvent = await emitReviewerDelegationRoutedEventAsync(
            orchestratorRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routedEvent || taskEventAppendHasBlockingFailure(routedEvent, false)) {
            throw new Error(
                `Review routing requires REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        throw error;
    }
    console.log(
        `REVIEW_ROUTING_RECORDED: ${reviewType} ` +
        `(Context: ${normalizePath(contextPath)}, Sha256: ${routingUpdate.contextSha256 || 'n/a'})`
    );
}

export async function handlePrepareReviewerLaunch(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'prepare-reviewer-launch', 'review_phase');
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const reviewsRoot = path.dirname(preflightPath);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'prepare-reviewer-launch'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== reviewerExecutionMode || currentReviewerSessionId !== reviewerIdentity) {
        throw new Error(
            `Reviewer launch preparation requires review-context routing metadata for '${reviewType}' ` +
            `to match reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'. ` +
            'Run record-review-routing first.'
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    );
    if (!routingEvent) {
        throw new Error(
            `Reviewer launch preparation requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${reviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer launch preparation requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    const contextSha256 = fileSha256(contextPath);
    if (!contextSha256) {
        throw new Error(`Reviewer launch preparation requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    const existingArtifact = readJsonObjectIfPresent(launchArtifactPath);
    const existingEvidenceType = existingArtifact ? getStringField(existingArtifact, 'evidence_type', 'artifact_type') : '';
    const existingAttestationState = existingArtifact ? getStringField(existingArtifact, 'attestation_state', 'attestationState') : '';
    if (
        existingArtifact
        && existingEvidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        && existingAttestationState === 'launched'
        && getStringField(existingArtifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() === contextSha256
        && getStringField(existingArtifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() === routingEventProvenance.event_sha256
    ) {
        throw new Error(
            `Completed reviewer launch artifact already exists: ${normalizePath(launchArtifactPath)}. ` +
            'Run record-review-invocation for this completed launch evidence instead of replacing it.'
        );
    }

    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'prepare-reviewer-launch'
    });
    const promptPath = promptBinding.promptPath;
    const reviewTreeStateSha256 = getReviewTreeStateSha256(parsedReviewContext);
    const reviewTreeStateSummary = getReviewTreeStateLaunchSummary(parsedReviewContext);
    const providerLaunch = resolveProviderLaunchMetadata(runtimeIdentity);
    const reviewerPromptSha256 = promptBinding.reviewerPromptSha256;
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256
    });
    const recordInvocationCommand = buildRecordReviewInvocationCommand({
        repoRoot,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextPath: contextPath,
        reviewerLaunchArtifactPath: launchArtifactPath
    });
    const preparedArtifact = {
        schema_version: 1,
        evidence_type: PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        attestation_state: 'prepared',
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_identity: reviewerIdentity,
        review_context_path: normalizePath(contextPath),
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventProvenance.event_sha256,
        routing_event_task_sequence: routingEventProvenance.task_sequence,
        reviewer_prompt_path: normalizePath(promptPath),
        reviewer_prompt_sha256: reviewerPromptSha256,
        review_tree_state_sha256: reviewTreeStateSha256 || null,
        review_tree_state: reviewTreeStateSummary,
        launch_binding_sha256: launchBindingSha256,
        provider: providerLaunch.provider,
        launch_tool: providerLaunch.launchTool,
        launch_instruction: providerLaunch.launchInstruction,
        fresh_context_required: true,
        isolated_context_required: true,
        local_trust_boundary: LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
        after_launch_required_updates: {
            evidence_type: COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
            attestation_state: 'launched',
            attestation_source: '<provider/controller source, not garda_prepare_reviewer_launch/manual/mock>',
            launch_tool: providerLaunch.launchTool,
            provider_invocation_id_or_controller_invocation_id: '<actual delegated reviewer invocation id>',
            launched_at_utc: '<ISO-8601 launch timestamp>',
            fresh_context: true,
            isolated_context: true,
            fork_context: false
        },
        preserve_prepared_fields: [
            'review_context_sha256',
            'routing_event_sha256',
            'reviewer_prompt_sha256',
            'review_tree_state_sha256',
            'launch_binding_sha256',
            'prepared_launch_event_sha256',
            'prepared_launch_event_task_sequence'
        ],
        record_invocation_command: recordInvocationCommand,
        attestation_source: PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
        generated_by: 'garda prepare-reviewer-launch',
        generated_at_utc: new Date().toISOString(),
        next_action: (
            'Launch a fresh delegated reviewer with the reviewer_prompt_path as an opaque handoff artifact; ' +
            'do not open or summarize the generated review context in the main agent. Then update only the ' +
            'after_launch_required_updates fields while preserving the prepared hashes. ' +
            'Run record_invocation_command after the real launch is recorded in this artifact.'
        )
    };
    writeReviewArtifactJson(launchArtifactPath, preparedArtifact);
    const preparedEvent = await emitReviewerLaunchPreparedEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        contextSha256,
        routingEventProvenance.event_sha256,
        launchBindingSha256,
        {
            launchDetails: {
                reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                reviewer_prompt_path: normalizePath(promptPath),
                reviewer_prompt_sha256: reviewerPromptSha256,
                launch_tool: providerLaunch.launchTool,
                attestation_source: PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE
            }
        }
    );
    if (!preparedEvent || taskEventAppendHasBlockingFailure(preparedEvent, false) || !preparedEvent.integrity?.event_sha256) {
        removeArtifactIfExists(launchArtifactPath);
        throw new Error(
            `Reviewer launch preparation requires REVIEWER_LAUNCH_PREPARED telemetry for '${reviewType}'. ` +
            'The lifecycle event could not be persisted.'
        );
    }
    const preparedLaunchEventSha256 = String(preparedEvent.integrity.event_sha256 || '').trim().toLowerCase();
    const preparedLaunchEventTaskSequence = preparedEvent.integrity.task_sequence;
    writeReviewArtifactJson(launchArtifactPath, {
        ...preparedArtifact,
        prepared_launch_event_sha256: preparedLaunchEventSha256,
        prepared_launch_event_task_sequence: preparedLaunchEventTaskSequence
    });
    assertPreparedReviewerLaunchArtifact({
        artifactPath: launchArtifactPath,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256,
        reviewTreeStateSha256
    });
    const launchArtifactSha256 = fileSha256(launchArtifactPath) || '';

    console.log(`REVIEWER_LAUNCH_PREPARED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`ReviewContextPath: ${normalizePath(contextPath)}`);
    console.log(`ReviewContextSha256: ${contextSha256}`);
    console.log(`RoutingEventSha256: ${routingEventProvenance.event_sha256}`);
    console.log(`LaunchBindingSha256: ${launchBindingSha256}`);
    console.log(`PreparedLaunchEventSha256: ${preparedLaunchEventSha256}`);
    console.log(`ReviewerPromptPath: ${normalizePath(promptPath)}`);
    if (reviewTreeStateSha256) {
        console.log(`ReviewTreeStateSha256: ${reviewTreeStateSha256}`);
    }
    console.log(`ReviewerLaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`ReviewerLaunchArtifactSha256: ${launchArtifactSha256}`);
    console.log('AttestationState: prepared');
    console.log(`LaunchTool: ${providerLaunch.launchTool}`);
    console.log(`LaunchInstruction: ${providerLaunch.launchInstruction}`);
    console.log(`HandoffInstruction: ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION}`);
    console.log(`TrustBoundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`);
    console.log(`RequiredCompletedFields: ${REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS.join('; ')}`);
    console.log('PreservePreparedFields: review_context_sha256, routing_event_sha256, reviewer_prompt_sha256, review_tree_state_sha256, launch_binding_sha256, prepared_launch_event_sha256, prepared_launch_event_task_sequence');
    console.log(`RecordInvocationCommand: ${recordInvocationCommand}`);
    console.log('NextAction: launch the delegated reviewer with ReviewerPromptPath as an opaque handoff, update after_launch_required_updates, then run RecordInvocationCommand.');
}

export async function handleCompleteReviewerLaunch(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
        '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
        '--controller-invocation-id': { key: 'controllerInvocationId', type: 'string' },
        '--launched-at-utc': { key: 'launchedAtUtc', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--fresh-context': { key: 'freshContext', type: 'boolean' },
        '--isolated-context': { key: 'isolatedContext', type: 'boolean' },
        '--fork-context': { key: 'forkContext', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'complete-reviewer-launch', 'review_phase');
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const reviewsRoot = path.dirname(preflightPath);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }
    const { reviewerExecutionMode, reviewerIdentity } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );

    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const controllerInvocationId = String(options.controllerInvocationId || '').trim();
    if (!providerInvocationId && !controllerInvocationId) {
        throw new Error('ProviderInvocationId or ControllerInvocationId is required (the actual delegated reviewer invocation id).');
    }
    if (providerInvocationId && controllerInvocationId) {
        throw new Error('Provide either --provider-invocation-id or --controller-invocation-id, not both.');
    }
    const launchedAtUtc = String(options.launchedAtUtc || '').trim();
    if (!launchedAtUtc) {
        throw new Error('LaunchedAtUtc is required (ISO-8601 launch timestamp).');
    }
    if (!isValidUtcIso8601Timestamp(launchedAtUtc)) {
        throw new Error('LaunchedAtUtc must be a valid UTC ISO-8601 timestamp.');
    }
    const attestationSource = normalizeReviewerLaunchAttestationSource(options.attestationSource);
    if (!attestationSource) {
        throw new Error('AttestationSource is required (provider/controller source).');
    }
    if (isForbiddenReviewerLaunchAttestationSource(attestationSource)) {
        throw new Error(
            `AttestationSource '${attestationSource}' is not a valid provider/controller-owned attestation source. ` +
            'Use the actual provider or controller identifier (e.g., claude_task_tool_launch, codex_agent_launch).'
        );
    }
    const freshContext = options.freshContext === true || options.isolatedContext === true || options.forkContext === false;
    if (!freshContext) {
        throw new Error(
            'At least one of --fresh-context, --isolated-context, or --fork-context false must attest clean reviewer context.'
        );
    }

    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
        throw new Error(
            `Reviewer launch artifact not found: ${normalizePath(launchArtifactPath)}. ` +
            'Run prepare-reviewer-launch first.'
        );
    }

    const contextSha256 = fileSha256(contextPath);
    if (!contextSha256) {
        throw new Error(`Reviewer launch completion requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'complete-reviewer-launch'
    });
    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'complete-reviewer-launch'
    });
    const reviewTreeStateSha256 = getReviewTreeStateSha256(parsedReviewContext);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(timelineEvents, reviewType, reviewerExecutionMode, reviewerIdentity, null);
    if (!routingEvent) {
        throw new Error(
            `Reviewer launch completion requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${reviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer launch completion requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    assertPreparedReviewerLaunchArtifact({
        artifactPath: launchArtifactPath,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256: promptBinding.reviewerPromptSha256,
        reviewTreeStateSha256
    });

    const preparedArtifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
    const completedArtifact: Record<string, unknown> = {
        ...preparedArtifact,
        evidence_type: COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        attestation_state: 'launched',
        attestation_source: attestationSource
    };
    if (providerInvocationId) {
        completedArtifact.provider_invocation_id = providerInvocationId;
    } else {
        completedArtifact.controller_invocation_id = controllerInvocationId;
    }
    completedArtifact.launched_at_utc = launchedAtUtc;
    if (options.freshContext === true) {
        completedArtifact.fresh_context = true;
    }
    if (options.isolatedContext === true) {
        completedArtifact.isolated_context = true;
    }
    if (options.forkContext !== undefined) {
        completedArtifact.fork_context = options.forkContext;
    }
    writeReviewArtifactJson(launchArtifactPath, completedArtifact);

    const invocationId = providerInvocationId || controllerInvocationId;
    const invocationIdLabel = providerInvocationId ? 'ProviderInvocationId' : 'ControllerInvocationId';
    console.log(`REVIEWER_LAUNCH_COMPLETED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`${invocationIdLabel}: ${invocationId}`);
    console.log(`LaunchedAtUtc: ${launchedAtUtc}`);
    console.log(`AttestationSource: ${attestationSource}`);
    console.log(`TrustBoundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`);
    const recordCommand = getStringField(preparedArtifact, 'record_invocation_command', 'recordInvocationCommand');
    if (recordCommand) {
        console.log(`RecordInvocationCommand: ${recordCommand}`);
    }
    console.log('NextAction: run RecordInvocationCommand to attest the invocation.');
}

export async function handleRecordReviewInvocation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-invocation', 'review_phase');
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const reviewsRoot = path.dirname(preflightPath);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-invocation'
    });
    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-invocation'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== reviewerExecutionMode || currentReviewerSessionId !== reviewerIdentity) {
        throw new Error(
            `Reviewer invocation attestation requires review-context routing metadata for '${reviewType}' ` +
            `to match reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'.`
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    );
    if (!routingEvent) {
        throw new Error(
            `Reviewer invocation attestation requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${reviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer invocation attestation requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    const contextSha256 = fileSha256(contextPath);
    if (!contextSha256) {
        throw new Error(`Reviewer invocation attestation requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const launchArtifact = validateReviewerLaunchArtifact({
        repoRoot,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256: promptBinding.reviewerPromptSha256,
        reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext),
        routingEventSequence: routingEvent.sequence,
        timelineEvents,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    const invocationEvent = await emitReviewerInvocationAttestedEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        contextSha256,
        routingEventProvenance.event_sha256,
        {
            launchDetails: {
                reviewer_launch_artifact_path: normalizePath(launchArtifact.artifactPath),
                reviewer_launch_artifact_sha256: launchArtifact.artifactSha256,
                reviewer_launch_attestation_source: launchArtifact.attestationSource,
                reviewer_launch_tool: launchArtifact.launchTool,
                provider_invocation_id: launchArtifact.providerInvocationId,
                launched_at_utc: launchArtifact.launchedAtUtc,
                review_tree_state_sha256: getReviewTreeStateSha256(parsedReviewContext) || null
            }
        }
    );
    if (!invocationEvent || taskEventAppendHasBlockingFailure(invocationEvent, false)) {
        throw new Error(
            `Reviewer invocation attestation requires REVIEWER_INVOCATION_ATTESTED telemetry for '${reviewType}'. ` +
            'The lifecycle event could not be persisted.'
        );
    }
    console.log(`REVIEWER_INVOCATION_ATTESTED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifact.artifactPath)}`);
    console.log(`LaunchArtifactSha256: ${launchArtifact.artifactSha256}`);
}

export async function handleRecordReviewResult(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--review-output-stdin': { key: 'reviewOutputStdin', type: 'boolean' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-result', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const reviewOutput = await resolveReviewOutputInput(options, repoRoot, path.dirname(preflightPath), taskId, reviewType);
    const rawReviewOutputSha256 = fileSha256(reviewOutput.reviewOutputPath);
    let reviewContent = reviewOutput.reviewContent;
    let reviewMaterializationFidelity = 'exact';
    const expectedPassVerdict = REVIEW_CONTRACTS.find(([candidate]) => candidate === reviewType)?.[1] || null;
    if (!expectedPassVerdict) {
        throw new Error(`Unsupported review type '${reviewType}' for record-review-result.`);
    }
    const expectedFailVerdict = expectedPassVerdict.replace(/\bPASSED\b/, 'FAILED');
    const verdictTokenSet = buildReviewVerdictTokenSet(reviewType, expectedPassVerdict, expectedFailVerdict);
    const verdictToken = extractReviewVerdictToken(reviewContent, expectedPassVerdict, expectedFailVerdict, reviewType);
    if (!verdictToken) {
        const passExample = verdictTokenSet.canonicalPassToken || expectedPassVerdict;
        const failExample = verdictTokenSet.canonicalFailToken || expectedFailVerdict;
        throw new Error(
            `Review output must contain a recognized verdict token for '${reviewType}'. ` +
            formatAcceptedReviewVerdictTokens(verdictTokenSet) +
            ` The token must appear as a standalone line inside the reviewer output file (--review-output-path), not as a CLI flag. ` +
            `Example PASS line: '${passExample}'. Example FAIL line: '${failExample}'. ` +
            `Do not pass '--verdict pass' or similar flags; place the token on its own line under a '## Verdict' heading in the review output file.`
        );
    }
    const materializationAnalysis = analyzeEarlyReviewMaterialization({
        artifactPath,
        reviewContent,
        verdictToken,
        expectedPassVerdict
    });
    const normalizedHeadings = normalizeCanonicalReviewSectionHeadings(reviewContent);
    if (normalizedHeadings.changed) {
        const normalizedHeadingAnalysis = analyzeEarlyReviewMaterialization({
            artifactPath,
            reviewContent: normalizedHeadings.content,
            verdictToken,
            expectedPassVerdict
        });
        if (normalizedHeadingAnalysis.violations.length <= materializationAnalysis.violations.length) {
            reviewContent = normalizedHeadings.content;
            reviewMaterializationFidelity = 'normalized_lossless';
            materializationAnalysis.violations = normalizedHeadingAnalysis.violations;
            materializationAnalysis.findingsEvidence = normalizedHeadingAnalysis.findingsEvidence;
        }
    }
    if (verdictToken === expectedPassVerdict) {
        const normalizedPassReviewContent = buildLosslessPassReviewNormalization({
            reviewType,
            reviewContent,
            expectedPassVerdict,
            findingsEvidence: materializationAnalysis.findingsEvidence
        });
        if (normalizedPassReviewContent) {
            const normalizedAnalysis = analyzeEarlyReviewMaterialization({
                artifactPath,
                reviewContent: normalizedPassReviewContent,
                verdictToken,
                expectedPassVerdict
            });
            const preservedBlockingViolations = materializationAnalysis.violations.filter(
                (violation) => !isLosslessPassNormalizationEligibleViolation(violation)
            );
            if (normalizedAnalysis.violations.length === 0) {
                reviewContent = normalizedPassReviewContent;
                reviewMaterializationFidelity = 'normalized_lossless';
                materializationAnalysis.violations = preservedBlockingViolations;
                materializationAnalysis.findingsEvidence = normalizedAnalysis.findingsEvidence;
            }
        }
    }
    if (materializationAnalysis.violations.length > 0) {
        const passTemplateHint = buildPassReviewTemplateHintMessage({
            reviewType,
            verdictToken,
            expectedPassVerdict,
            reviewContent,
            findingsEvidence: materializationAnalysis.findingsEvidence
        });
        throw new Error(
            `Review output is not eligible for '${reviewType}' materialization:\n` +
            materializationAnalysis.violations.map((violation) => `- ${violation}`).join('\n') +
            (passTemplateHint ? `\n\n${passTemplateHint}` : '')
        );
    }

    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-result'
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-result'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const artifactRollbackState = captureReviewArtifactRollbackState(artifactPath);
    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    writeReviewArtifactText(artifactPath, reviewContent.endsWith('\n') ? reviewContent : `${reviewContent}\n`);
    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });

    try {
        const receiptPath = await recordReviewReceiptFromArtifacts({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            artifactPath,
            contextPath,
            rawReviewOutputPath: reviewOutput.reviewOutputPath,
            rawReviewOutputSha256,
            reviewMaterializationFidelity,
            taskModePath: String(options.taskModePath || '').trim(),
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason,
            requireStrictBindingMetadata: !!options.reviewContextPath
        });
        cleanupReviewTempSourceArtifact(repoRoot, taskId, reviewOutput.reviewOutputSourcePath);

        console.log(`REVIEW_RESULT_RECORDED: ${reviewType}`);
        console.log(`ArtifactPath: ${normalizePath(artifactPath)}`);
        console.log(`ContextPath: ${normalizePath(contextPath)}`);
        console.log(`ReceiptPath: ${normalizePath(receiptPath)}`);
        console.log(`ReviewerExecutionMode: ${reviewerExecutionMode}`);
        console.log(`ReviewerIdentity: ${reviewerIdentity}`);
        console.log(`ReviewOutputMode: ${reviewOutput.reviewOutputMode}`);
        console.log(`ReviewOutputPath: ${normalizePath(reviewOutput.reviewOutputPath)}`);
        console.log(`ReviewOutputSha256: ${rawReviewOutputSha256 || 'n/a'}`);
        console.log(`ReviewMaterializationFidelity: ${reviewMaterializationFidelity}`);
        if (reviewOutput.reviewOutputSourcePath) {
            console.log(`ReviewOutputSourcePath: ${normalizePath(reviewOutput.reviewOutputSourcePath)}`);
        }
        console.log(`ContextSha256: ${routingUpdate.contextSha256 || 'n/a'}`);
        if (reviewerFallbackReason) {
            console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
        }
        console.log(`VerdictToken: ${verdictToken}`);
        console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        try {
            restoreReviewArtifactFromRollbackState(artifactPath, artifactRollbackState, { ensureTrailingNewline: true });
        } catch {
            // Best-effort rollback only.
        }
        throw error;
    }
}

export async function handleRecordReviewReceipt(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}
