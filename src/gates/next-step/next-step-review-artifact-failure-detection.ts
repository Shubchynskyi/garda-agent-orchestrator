const REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\breviewer_prompt_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breviewer_prompt_sha256\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\breview_context_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_context_sha256\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\breview_tree_state_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_tree_state_sha256\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:launch package|launch artifact|prepared launch|reviewer launch|invocation attestation|launch binding)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch package mismatch' },
    { pattern: /\b(?:wrong|stale|invalid)\s+(?:prompt|context|tree-state|tree state)\s+hash\b/i, reason: 'reviewer launch hash mismatch' }
];
const REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN =
    /\b(?:reviewer\s+failed\s+before\s+\w+\s+review|reviewer\s+launch\s+artifact\s+is\s+not\s+eligible\s+for\s+invocation\s+attestation|reviewer\s+launch\s+package\s+failure|launch\s+package\s+failure|launch\s+metadata\s+failure|invocation\s+attestation\s+failed)\b/i;
const REVIEW_MISSING_VALIDATION_EVIDENCE_PATTERN =
    /\b(?:missing|omitted|absent|not attached|not provided|could not find)\b[\s\S]{0,200}\b(?:manual[-\s]?validation|validation\s+(?:log|logs|evidence)|runtime\/manual-validation|gradle\s+(?:test|check)\s+(?:log|logs|evidence))\b/i;
const REVIEW_EVIDENCE_ONLY_FAILURE_PATTERN =
    /\b(?:evidence[-\s]?only|implementation\s+diff\s+itself\s+was\s+not\s+reviewed\s+as\s+defective|no\s+(?:implementation|code|security|test|refactor)\s+findings?|no\s+implementation\s+defects?|(?:only\s+(?:defect|finding|blocker|problem|issue)\s+is\s+missing)|(?:manual[-\s]?validation|validation\s+(?:log|logs|evidence)|runtime\/manual-validation)[\s\S]{0,120}\bmust\s+be\s+attached\s+before\s+(?:a\s+)?meaningful\s+\w*\s*review)\b/i;
const REVIEW_REAL_FINDING_MARKER_PATTERN =
    /\b(?:critical|high|medium|low|p[0-3])\s*:\s|\b(?<!no\s)(?:findings?|bugs?|defects?|regressions?|incorrect|unsafe|crashes?|leaks?|bypasses|bypassed|bypass|race|data loss|misroutes?|misrouted|misrouting)\b/i;
const REVIEW_EVIDENCE_ONLY_BENIGN_REASSURANCE_PATTERN =
    /\bno\s+(?:other\s+)?(?:blocking\s+)?(?:implementation|code|security|test|refactor)?\s*(?:findings?|bugs?|defects?|issues?|problems?|regressions?)\b/giu;

export function detectReviewLaunchPackageFailureReason(content: string): string | null {
    if (!REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN.test(content)) {
        return null;
    }
    const match = REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(content));
    return match?.reason || null;
}

function extractMarkdownSection(content: string, heading: string): string | null {
    const headingPattern = /^#{2,6}\s+(.+?)\s*#*\s*$/gim;
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(content)) !== null) {
        const normalizedHeading = match[1].trim().toLowerCase();
        if (normalizedHeading !== heading.toLowerCase()) {
            continue;
        }
        const sectionStart = headingPattern.lastIndex;
        const nextHeading = headingPattern.exec(content);
        return content.slice(sectionStart, nextHeading?.index ?? content.length);
    }
    return null;
}

function hasNonEmptyFindingsBySeveritySection(content: string): boolean {
    const section = extractMarkdownSection(content, 'Findings by Severity');
    if (section == null) {
        return false;
    }
    const normalized = section
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/^[\s>*-]+/gmu, '')
        .trim();
    if (!normalized) {
        return false;
    }
    return !/^(?:none|no findings|no blocking findings|no issues found|n\/a)[\s.]*$/iu.test(normalized);
}

function hasEmptyFindingsBySeveritySection(content: string): boolean {
    const section = extractMarkdownSection(content, 'Findings by Severity');
    if (section == null) {
        return false;
    }
    const normalized = section
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/^[\s>*-]+/gmu, '')
        .trim();
    return !normalized || /^(?:none|no findings|no blocking findings|no issues found|n\/a)[\s.]*$/iu.test(normalized);
}

function findingsBySeverityContainsOnlyMissingValidationEvidence(content: string): boolean {
    const section = extractMarkdownSection(content, 'Findings by Severity');
    if (section == null) {
        return false;
    }
    const findingLines = section
        .replace(/<!--[\s\S]*?-->/gu, '')
        .split(/\r?\n/u)
        .map((line) => line.replace(/^[\s>*-]+/u, '').trim())
        .filter((line) => line && !/^(?:none|no findings|no blocking findings|no issues found|n\/a)[\s.]*$/iu.test(line));
    if (findingLines.length === 0) {
        return false;
    }
    return findingLines.every((line) => {
        const withoutSeverity = line.replace(/^(?:critical|high|medium|low|p[0-3])\s*:\s*/iu, '');
        if (!REVIEW_MISSING_VALIDATION_EVIDENCE_PATTERN.test(withoutSeverity)) {
            return false;
        }
        const withoutMissingEvidence = withoutSeverity
            .replace(REVIEW_MISSING_VALIDATION_EVIDENCE_PATTERN, '')
            .replace(REVIEW_EVIDENCE_ONLY_BENIGN_REASSURANCE_PATTERN, '');
        return !REVIEW_REAL_FINDING_MARKER_PATTERN.test(withoutMissingEvidence);
    });
}

export function detectMissingValidationEvidenceFailureReason(content: string): string | null {
    if (!REVIEW_MISSING_VALIDATION_EVIDENCE_PATTERN.test(content)) {
        return null;
    }
    const emptyFindingsBySeverity = hasEmptyFindingsBySeveritySection(content);
    const missingOnlyFindingsBySeverity = findingsBySeverityContainsOnlyMissingValidationEvidence(content);
    const explicitEvidenceOnlyFailure = REVIEW_EVIDENCE_ONLY_FAILURE_PATTERN.test(content);
    if (!explicitEvidenceOnlyFailure && !missingOnlyFindingsBySeverity) {
        return null;
    }
    if (hasNonEmptyFindingsBySeveritySection(content) && !missingOnlyFindingsBySeverity) {
        return null;
    }
    if (explicitEvidenceOnlyFailure && !emptyFindingsBySeverity && !missingOnlyFindingsBySeverity) {
        const contentWithoutHeadings = content.replace(/^#{2,6}\s+.+$/gmu, '');
        if (REVIEW_REAL_FINDING_MARKER_PATTERN.test(contentWithoutHeadings)) {
            return null;
        }
    }
    return 'missing attached manual-validation evidence';
}
