import * as fs from 'node:fs';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    extractMarkdownSectionLines,
    getCanonicalReviewSectionHeading,
    getMarkdownMeaningfulEntries,
    getReviewArtifactFindingsEvidence,
    isTrivialReview
} from '../../../../gates/completion/completion';
import {
    resolveReviewerHandoffArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';

type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

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
