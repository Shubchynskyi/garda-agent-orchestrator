import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerProvenance,
    extractReviewVerdictToken,
    normalizeReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../../gate-runtime/review-context';
import { assertValidTaskId } from '../../../gate-runtime/task-events';
import { fileSha256 } from '../../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync,
    emitReviewRecordedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import { writeReviewArtifactJson, writeReviewArtifactText } from '../../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { REVIEW_CONTRACTS } from '../../../gates/required-reviews-check';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../../gates/review-dependencies';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../gates/review-reuse';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import { getReviewContextContractViolations } from '../../../gates/review-context-contract';
import { resolveReviewContextRoutingIdentity } from '../../../gates/review-context-routing';
import { assertReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import { normalizeRuntimeIdentitySource, resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import {
    extractMarkdownSectionLines,
    getReviewArtifactFindingsEvidence,
    isTrivialReview
} from '../../../gates/completion';
import {
    cleanupReviewTempSourceArtifact
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
    reviewerExecutionMode: NonNullable<ReturnType<typeof normalizeReviewerExecutionMode>>;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

interface ReviewArtifactRollbackState {
    existed: boolean;
    content: string | null;
}

interface ResolvedReviewOutputInput {
    reviewContent: string;
    reviewOutputPath: string;
    reviewOutputMode: 'path' | 'stdin';
    reviewOutputSourcePath: string | null;
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
    const resolvedPreflightPath = gateHelpers.resolvePathInsideRepo(String(preflightPathValue || ''), repoRoot, { allowMissing: true });
    if (!resolvedPreflightPath) {
        throw new Error('PreflightPath is required.');
    }
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

function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
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
                "Expected one of 'delegated_subagent' or 'same_agent_fallback'."
            );
        }
        throw new Error(modeRequiredMessage);
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review evidence cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review evidence requires an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (!reviewerIdentity.startsWith('self:')) {
        throw new Error("Fallback review evidence requires a self-scoped reviewer identity (prefix 'self:').");
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

function captureReviewArtifactRollbackState(artifactPath: string): ReviewArtifactRollbackState {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            existed: false,
            content: null
        };
    }
    return {
        existed: true,
        content: fs.readFileSync(artifactPath, 'utf8')
    };
}

function restoreReviewArtifactFromRollbackState(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState
): void {
    if (!rollbackState.existed) {
        removeArtifactIfExists(artifactPath);
        return;
    }
    const content = rollbackState.content || '';
    writeReviewArtifactText(artifactPath, content.endsWith('\n') ? content : `${content}\n`);
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
            return !!headingMatch && headingMatch[2].trim().toLowerCase() === heading.trim().toLowerCase();
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
        if (headingMatch && CANONICAL_REVIEW_SECTION_HEADINGS.has(headingMatch[2].trim().toLowerCase())) {
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
        || normalizedViolation.includes("missing required section '## findings by severity'")
        || normalizedViolation.includes("missing required section '## residual risks'")
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
    if (
        reviewerExecutionMode === 'delegated_subagent' &&
        (capabilityLevel === 'single_agent_only' || expectedExecutionMode === 'same_agent_fallback')
    ) {
        throw new Error(
            `Review '${reviewType}' cannot record delegated_subagent routing for provider ` +
            `'${providerLabel}'. Explicit fallback is required instead.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && !fallbackAllowed) {
        throw new Error(
            `Review '${reviewType}' does not allow same_agent_fallback for provider '${providerLabel}'.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && fallbackReasonRequired && !reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' requires --reviewer-fallback-reason for same_agent_fallback ` +
            `on provider '${providerLabel}'.`
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
    requireStrictBindingMetadata?: boolean;
}): void {
    const violations = getReviewContextContractViolations({
        contextPath: options.contextPath,
        reviewContext: options.reviewContext,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: true,
        requireTaskId: options.requireStrictBindingMetadata === true,
        requirePreflightPath: options.requireStrictBindingMetadata === true,
        requirePreflightSha256: options.requireStrictBindingMetadata === true
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
    const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
    return entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
        && normalizeReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
        && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''));
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
        requireStrictBindingMetadata: options.requireStrictBindingMetadata
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
    const currentExecutionMode = normalizeReviewerExecutionMode(currentRouting?.actual_execution_mode);
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
        options.reviewerExecutionMode === 'same_agent_fallback' &&
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
    const reviewerProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (options.reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
        throw new Error(
            `Review receipts require controller-attested reviewer_provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Matching routing telemetry is missing event integrity.'
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256: preflight.metrics?.changed_files_sha256 || null,
        codeScopeSha256: options.reviewType === 'code'
            ? computeCodeReviewScopeFingerprint(preflight as Record<string, unknown>, options.repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: contextSha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: 'LOCAL_ASSERTED'
    });
    (receipt as unknown as Record<string, unknown>).review_output_path = options.rawReviewOutputPath
        ? normalizePath(options.rawReviewOutputPath)
        : null;
    (receipt as unknown as Record<string, unknown>).review_output_sha256 = options.rawReviewOutputSha256 || null;
    (receipt as unknown as Record<string, unknown>).review_materialization_fidelity = options.reviewMaterializationFidelity || 'exact';

    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    writeReviewArtifactJson(receiptPath, receipt);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    try {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...receipt,
            receipt_path: normalizePath(receiptPath),
            review_artifact_path: normalizePath(options.artifactPath),
            review_context_path: normalizePath(options.contextPath)
        });
        if (!recordedEvent || (Array.isArray(recordedEvent.warnings) && recordedEvent.warnings.length > 0)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        removeArtifactIfExists(receiptPath);
        throw error;
    }
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
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (!reviewerExecutionMode) {
        throw new Error("ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'.");
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review routing cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review routing requires an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (!reviewerIdentity.startsWith('self:')) {
        throw new Error("Fallback review routing requires a self-scoped reviewer identity (prefix 'self:').");
    }
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
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
        requireStrictBindingMetadata: !!options.reviewContextPath
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
        if (!routedEvent || (Array.isArray(routedEvent.warnings) && routedEvent.warnings.length > 0)) {
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
    const verdictToken = extractReviewVerdictToken(reviewContent, expectedPassVerdict, expectedFailVerdict);
    if (!verdictToken) {
        throw new Error(
            `Review output must contain a recognized verdict token for '${reviewType}'. ` +
            `Expected '${expectedPassVerdict}' or '${expectedFailVerdict}'.`
        );
    }
    const materializationAnalysis = analyzeEarlyReviewMaterialization({
        artifactPath,
        reviewContent,
        verdictToken,
        expectedPassVerdict
    });
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
        "ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'."
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
        requireStrictBindingMetadata: !!options.reviewContextPath
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
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        try {
            restoreReviewArtifactFromRollbackState(artifactPath, artifactRollbackState);
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
        "ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'."
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
}
