import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    normalizeCompatibilityReviewerExecutionMode,
} from '../../../gate-runtime/review-context';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import {
    resolveReviewerHandoffArtifactBinding,
} from '../../../gates/review-prompt-artifact';
import {
    resolveDefaultReviewScratchPath
} from '../../../gates/review-scratch-paths';
import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import { getProviderEntryById } from '../../../core/provider-registry';
import {
    extractMarkdownSectionLines,
    getCanonicalReviewSectionHeading,
    getMarkdownMeaningfulEntries,
    getReviewArtifactFindingsEvidence,
    isTrivialReview
} from '../../../gates/completion';
import {
    isTaskOwnedReviewTempPath
} from '../gates-artifacts';
import {
    type ParsedOptionsRecord
} from '../shared-command-utils';
export {
    buildReviewerLaunchBindingSha256,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME,
    stringSha256,
    type ReviewerLaunchInputAttestation,
    type ReviewerLaunchInputMode
} from './review-launch-input-attestation';
export {
    assertPreparedReviewerLaunchArtifact,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    validateReviewerLaunchArtifact,
    type ReviewerLaunchArtifactValidationResult,
    type SupersededReviewerLaunchArtifactSnapshot
} from './review-launch-artifact-validation';
export {
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    findMatchingReviewerInvocationAttestationEvent,
    findMatchingRoutingEvent
} from './review-context-runtime-validation';

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

interface ReviewerHandoffBindings {
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
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

export function toReviewerHandoffAbsolutePath(repoRoot: string, artifactPath: string): string {
    const trimmedPath = String(artifactPath || '').trim();
    if (!trimmedPath) {
        return '';
    }
    return normalizePath(path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(repoRoot, trimmedPath));
}

function getObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function getReviewerScopedDiffHandoffPaths(repoRoot: string, reviewContext: Record<string, unknown>) {
    const scopedDiff = getObjectField(reviewContext, 'scoped_diff');
    if (!scopedDiff) {
        return {
            metadataPath: '',
            outputPath: '',
            cachePath: ''
        };
    }
    const metadata = getObjectField(scopedDiff, 'metadata');
    return {
        metadataPath: toReviewerHandoffAbsolutePath(repoRoot, getStringField(scopedDiff, 'metadata_path')),
        outputPath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'output_path') : ''),
        cachePath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'cache_path', 'diff_cache_path') : getStringField(scopedDiff, 'diff_cache_path'))
    };
}

export function buildRecordReviewInvocationCommand(options: {
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

export function resolveReviewerDraftOutputPath(reviewerLaunchArtifactPath: string): string {
    return path.join(path.dirname(reviewerLaunchArtifactPath), 'review-output.md');
}

export function buildCopyPasteReviewerLaunchPrompt(options: {
    repoRoot: string;
    reviewType: string;
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    reviewerPromptPath: string;
    reviewerPromptSha256: string;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
    reviewOutputPath: string;
}): string {
    const lines = [
        `You are the delegated ${options.reviewType} reviewer for this Garda task.`,
        `Repository: ${options.repoRoot}`
    ];
    if (options.rolePromptPath) {
        lines.push(`First open and read RolePromptPath: ${options.rolePromptPath}`);
        if (options.rolePromptSha256) {
            lines.push(`RolePromptSha256: ${options.rolePromptSha256}`);
        }
        lines.push(`Then open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    } else {
        lines.push(`First open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    }
    lines.push(
        `PromptTemplateSha256: ${options.promptTemplateSha256}`,
        `Then open and read ReviewerPromptPath: ${options.reviewerPromptPath}`,
        `ReviewerPromptSha256: ${options.reviewerPromptSha256}`,
        `Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence: ${options.evidenceManifestPath}`,
        `EvidenceManifestSha256: ${options.evidenceManifestSha256}`,
        `Fill OutputTemplatePath exactly, preserving the required sections: ${options.outputTemplatePath}`,
        `OutputTemplateSha256: ${options.outputTemplateSha256}`,
        'Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.',
        `Write the final review report to ReviewOutputPath when file writing is available, or return the filled report in your final response: ${options.reviewOutputPath}`,
        'Do not replace the required verdict token with a summary sentence.'
    );
    return lines.join('\n');
}

export function printCopyPasteReviewerLaunchPrompt(prompt: string): void {
    console.log('CopyPasteReviewerLaunchPrompt:');
    for (const line of prompt.split('\n')) {
        console.log(`  ${line}`);
    }
}

export function resolveReviewerHandoffBindings(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}): ReviewerHandoffBindings {
    const handoff = getObjectField(options.reviewContext, 'reviewer_handoff');
    const rolePrompt = handoff && getObjectField(handoff, 'role_prompt')
        ? resolveReviewerHandoffArtifactBinding({
            ...options,
            handoffKey: 'role_prompt',
            artifactLabel: 'reviewer role prompt'
        })
        : null;
    const promptTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'prompt_template',
        artifactLabel: 'reviewer prompt template'
    });
    const outputTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'output_template',
        artifactLabel: 'reviewer output template'
    });
    const evidenceManifest = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'evidence_manifest',
        artifactLabel: 'reviewer evidence manifest'
    });
    return {
        rolePromptPath: rolePrompt?.artifactPath || null,
        rolePromptSha256: rolePrompt?.artifactSha256 || null,
        promptTemplatePath: promptTemplate.artifactPath,
        promptTemplateSha256: promptTemplate.artifactSha256,
        outputTemplatePath: outputTemplate.artifactPath,
        outputTemplateSha256: outputTemplate.artifactSha256,
        evidenceManifestPath: evidenceManifest.artifactPath,
        evidenceManifestSha256: evidenceManifest.artifactSha256
    };
}

export function resolveCanonicalReviewPaths(
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

export function resolveCanonicalPreflightArtifactPath(repoRoot: string, taskId: string): string {
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
    assertArtifactPathRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${normalizePath(preflightPath)}.`);
    }
    return preflightPath;
}

export function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
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

export function buildMinimalPassReviewTemplateHint(reviewType: string, expectedPassVerdict: string): string {
    return [
        'Minimal compliant PASS review template for a no-findings review (structure only; substantive analysis is still required):',
        `Exact accepted PASS verdict token for '${reviewType}': ${expectedPassVerdict}`,
        `# ${getReviewHeading(reviewType)}`,
        '',
        '## Validation Notes',
        'Validated the relevant files with concrete scope notes, file references, behavior boundaries, and verification evidence.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Deferred Findings',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        expectedPassVerdict,
        "Use '## Deferred Findings' only for real accepted actionable follow-ups with 'Justification:'. Validation-boundary notes and command logs are prose only; keep the findings, deferred, and residual sections set to 'none'."
    ].join('\n');
}

type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

function getPassValidationNotesViolations(options: {
    artifactPath: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
    requirePassValidationNotes: boolean;
}): string[] {
    if (!options.requirePassValidationNotes || options.verdictToken !== options.expectedPassVerdict) {
        return [];
    }
    const normalizedArtifactPath = normalizePath(options.artifactPath);
    const lines = String(options.reviewContent || '').split('\n');
    const validationLines = extractMarkdownSectionLines(lines, 'Validation Notes');
    if (validationLines.length === 0) {
        return [
            `Review artifact '${normalizedArtifactPath}' is missing required PASS section '## Validation Notes'. ` +
            'Fill it with concrete reviewed files, behavior, boundaries, and verification evidence.'
        ];
    }
    const entries = getMarkdownMeaningfulEntries(validationLines);
    const joinedEntries = entries.join(' ').trim();
    const hasConcreteReference = /`[^`]+`/.test(joinedEntries)
        || /\b[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?\b/.test(joinedEntries);
    if (entries.length === 0 || joinedEntries.length < 80 || !hasConcreteReference) {
        return [
            `Review artifact '${normalizedArtifactPath}' has empty or non-substantive PASS validation notes. ` +
            'The `## Validation Notes` section must name concrete reviewed files and summarize checked behavior, boundaries, or verification evidence.'
        ];
    }
    return [];
}

export function analyzeEarlyReviewMaterialization(options: {
    artifactPath: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
    requirePassValidationNotes: boolean;
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
    violations.push(...getPassValidationNotesViolations(options));

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
            "Resolve active defects. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:'; validation-boundary or command/log notes must stay out of strict follow-up sections."
        );
    }
    if (findingsEvidence.residual_risks.length > 0) {
        passOnlyActiveViolations.add(
            `Review artifact '${normalizedArtifactPath}' still contains active residual risks. ` +
            "For validation-boundary or command/log notes, set 'Residual Risks' and 'Deferred Findings' to 'none' and keep the note in prose. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:' and will require follow-up tracking."
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

export function reviewContextRequiresPassValidationNotes(contextPath: string, repoRoot: string): boolean {
    const reviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const handoff = reviewContext.reviewer_handoff && typeof reviewContext.reviewer_handoff === 'object' && !Array.isArray(reviewContext.reviewer_handoff)
        ? reviewContext.reviewer_handoff as Record<string, unknown>
        : null;
    if (!handoff) {
        return false;
    }
    const outputTemplateBinding = resolveReviewerHandoffArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext,
        gateName: 'record-review-result',
        handoffKey: 'output_template',
        artifactLabel: 'reviewer output template'
    });
    const outputTemplateText = fs.readFileSync(outputTemplateBinding.artifactPath, 'utf8');
    return outputTemplateText.includes('## Validation Notes');
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
            "'## Residual Risks' is only for active open risks. For validation-boundary or command/log notes in a no-findings PASS review, keep those notes in prose and set '## Residual Risks' and '## Deferred Findings' to 'none'. Only real accepted actionable follow-ups belong in '## Deferred Findings' with 'Justification:' and become follow-up obligations."
        );
    } else if (findingsEvidence.missing_sections.includes('Residual Risks')) {
        hintLines.push(residualSectionPresent
            ? "Set '## Residual Risks' explicitly to 'none' when no active risks remain."
            : "Add mandatory section '## Residual Risks' and set it to 'none' when no active risks remain.");
    }
    if (findingsEvidence.invalid_deferred_findings.length > 0) {
        hintLines.push(
            "Every real '## Deferred Findings' entry must include 'Justification:' and becomes a follow-up obligation. If nothing actionable is deferred, remove that section or set it to 'none'; do not put validation-boundary or command/log notes there."
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

export function buildPassReviewTemplateHintMessage(options: {
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
    if (!/\bJustification\s*:/iu.test(normalizedEntry)) {
        lines.push('  Justification: Preserved from raw reviewer output during PASS review normalization.');
    }
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

function normalizeReviewNoteText(entry: string): string {
    return stripMarkdownListPrefix(entry)
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const PASS_REVIEW_COMMAND_HEADING_PATTERN = /^commands?(?:\s+(?:run|ran|i ran))?\s*:/u;

function isCommandOnlyValidationNote(normalizedEntry: string): boolean {
    if (!normalizedEntry || normalizedEntry.length > 180) {
        return false;
    }
    return /^(npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest|go test|cargo test|dotnet test|rg|grep|findstr|get-content|get-childitem|select-string|test-path|where-object|select-object|powershell|pwsh)\b/u.test(normalizedEntry)
        && !/\b(fail|failed|failure|error|regression|bug|missing|must|should|need|needs|fix|block|risk|vulnerab\w*|exploit\w*|unsafe|leak\w*|corrupt\w*|advisor(?:y|ies)|cve|rce|xss|credential\w*|secret\w*|token\w*|injection|traversal)\b/u.test(normalizedEntry);
}

function isGenericPassValidationBoundaryNote(
    entry: string,
    options: { filterStandaloneCommandNotes?: boolean } = {}
): boolean {
    const filterStandaloneCommandNotes = options.filterStandaloneCommandNotes ?? true;
    const normalizedEntry = normalizeReviewNoteText(entry);
    if (!normalizedEntry || normalizedEntry === 'none') {
        return true;
    }
    if (PASS_REVIEW_COMMAND_HEADING_PATTERN.test(normalizedEntry)) {
        return true;
    }
    if (filterStandaloneCommandNotes && isCommandOnlyValidationNote(normalizedEntry)) {
        return true;
    }

    const boundaryPatterns = [
        /\bfull (repository )?(test )?suite (was )?not run\b/u,
        /\bdid not run (the )?(entire|full|repository) (test )?suite\b/u,
        /\bdid not run tests?\b/u,
        /\btests? (were|was) not run\b/u,
        /\breview artifact (did not|does not|cannot) include (an )?(inline|scoped) diff\b/u,
        /\b(inline|scoped) diff (was )?(not included|not attached|omitted|absent|unavailable)\b/u,
        /\bwithout (an )?(inline|scoped) diff\b/u,
        /\bread[- ]only review\b/u,
        /\bfocused review only\b/u,
        /\bfocused validation\b/u,
        /\bfull[- ]suite validation (already )?(passed|ran|is gate[- ]owned|was covered)\b/u,
        /\bgate[- ]owned (compile|full[- ]suite|validation)\b/u,
        /\bcovered by (the )?(compile|full[- ]suite|mandatory) gate\b/u,
        /\bi did not identify (a )?(blocking )?(lifecycle|routing|review|test|regression|issue|risk|defect)/u,
        /\bcould not execute (the )?.*tests? directly\b/u,
        /\brequires the project'?s normal test harness\b/u,
        /\bdirect invocation fails at module loading\b/u,
        /\bbased on code inspection\b.*\b(correctly wired|coverage was added|coverage is present)\b/u,
        /\benforcement is correctly wired\b/u,
        /\bcould be sensitive to extreme clock skew\b/u,
        /\blow residual risk\b.*\bsuite passed\b/u,
        /\bspeculative\b.*\b(performance|environment|risk|hypothetical)/u
    ];
    if (boundaryPatterns.some((pattern) => pattern.test(normalizedEntry))) {
        return true;
    }

    const summarySignals = [
        'reviewed ',
        'validated ',
        'verified ',
        'checked ',
        'confirmed '
    ];
    const activeIssueSignals = /\b(fail|failed|failure|bug|defect|regression|vulnerability|exploit|unsafe|leak|corrupt|advisory|advisories|cve|rce|xss|credential|credentials|secret|secrets|token|tokens|injection|traversal|break|broken|missing|must|should|need|needs|fix|blocker|blocking|risk|follow[- ]up|actionable)\b/u;
    return summarySignals.some((signal) => normalizedEntry.startsWith(signal))
        && /\b(no|not|without)\b/u.test(normalizedEntry)
        && !activeIssueSignals.test(normalizedEntry);
}

function filterGenericPassValidationBoundaryEntries(
    entries: readonly string[],
    options: { filterStandaloneCommandNotes?: boolean } = {}
): string[] {
    const filteredEntries: string[] = [];
    let commandBlockActive = false;
    for (const entry of entries) {
        const normalizedEntry = normalizeReviewNoteText(entry);
        if (PASS_REVIEW_COMMAND_HEADING_PATTERN.test(normalizedEntry)) {
            commandBlockActive = true;
            continue;
        }
        if (commandBlockActive && isCommandOnlyValidationNote(normalizedEntry)) {
            continue;
        }
        commandBlockActive = false;
        if (isGenericPassValidationBoundaryNote(entry, options)) {
            continue;
        }
        filteredEntries.push(entry);
    }
    return filteredEntries;
}

export function isLosslessPassNormalizationEligibleViolation(violation: string): boolean {
    const normalizedViolation = String(violation || '').toLowerCase();
    return normalizedViolation.includes('still contains active ')
        || normalizedViolation.includes("deferred finding without usable 'justification:'");
}

function dedupeReviewFollowUpEntries(entries: readonly string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const entry of entries) {
        const key = normalizeReviewNoteText(entry);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(entry);
    }
    return deduped;
}

export function buildLosslessPassReviewNormalization(options: {
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
    const rawDeferredEntries = dedupeReviewFollowUpEntries(findingsEvidence.deferred_findings);
    const invalidDeferredEntries = dedupeReviewFollowUpEntries(findingsEvidence.invalid_deferred_findings);
    const rawResidualRiskEntries = findingsEvidence.residual_risks.map((entry) => `[follow-up] ${entry}`);
    const rawSourceEntries = dedupeReviewFollowUpEntries([
        ...rawDeferredEntries,
        ...invalidDeferredEntries,
        ...activeFindings,
        ...rawResidualRiskEntries
    ]);
    const activeResidualRisks = filterGenericPassValidationBoundaryEntries(
        rawResidualRiskEntries,
        { filterStandaloneCommandNotes: false }
    );
    const activeInvalidDeferredEntries = filterGenericPassValidationBoundaryEntries(invalidDeferredEntries);
    if (activeFindings.length > 0 || activeResidualRisks.length > 0 || activeInvalidDeferredEntries.length > 0) {
        return null;
    }
    const deferredEntries = filterGenericPassValidationBoundaryEntries(rawDeferredEntries);
    const rawPendingDeferredEntries = dedupeReviewFollowUpEntries(deferredEntries);
    if (rawSourceEntries.length === 0) {
        return null;
    }
    const pendingDeferredEntries = rawPendingDeferredEntries;

    const normalizedLines = [...extractReviewPreambleLines(reviewType, reviewContent)];
    if (normalizedLines.length === 0 || !normalizedLines[0].trim().startsWith('#')) {
        normalizedLines.unshift(`# ${getReviewHeading(reviewType)}`);
    }
    if (normalizedLines[normalizedLines.length - 1]?.trim().length !== 0) {
        normalizedLines.push('');
    }
    appendPreservedRawReviewerOutput(normalizedLines, reviewContent);
    const validationNotesLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Validation Notes');
    if (validationNotesLines.length > 0) {
        normalizedLines.push('## Validation Notes');
        normalizedLines.push(...validationNotesLines);
        if (normalizedLines[normalizedLines.length - 1]?.trim().length !== 0) {
            normalizedLines.push('');
        }
    }
    normalizedLines.push('## Findings by Severity');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Deferred Findings');
    normalizedLines.push('');
    if (pendingDeferredEntries.length === 0) {
        normalizedLines.push('none');
    } else {
        for (const entry of pendingDeferredEntries) {
            appendDeferredFinding(normalizedLines, entry);
        }
        if (normalizedLines[normalizedLines.length - 1]?.trim().length === 0) {
            normalizedLines.pop();
        }
    }
    normalizedLines.push('');
    normalizedLines.push('## Residual Risks');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Verdict');
    normalizedLines.push(expectedPassVerdict);
    return `${normalizedLines.join('\n')}\n`;
}

export function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`${label} must contain valid JSON: ${error.message}`);
        }
        throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

export function readJsonObjectIfPresent(pathValue: string): Record<string, unknown> | null {
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

export function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
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

export function resolveReviewerLaunchArtifactPathForWrite(options: {
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

export function getReviewTreeStateSha256(reviewContext: Record<string, unknown>): string {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    return treeState
        ? getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase()
        : '';
}

export function getReviewTreeStateLaunchSummary(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
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

export function resolveProviderLaunchMetadata(runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>): {
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


