import { normalizePath } from '../shared/helpers';
import {
    validateReviewFindingsReport,
    type ReviewFindingsReport
} from '../review/review-findings-schema';
import type { ReviewFindingsValidationArtifact } from '../review/review-findings-validation-artifact';
import {
    evaluateReviewFindingsValidationArtifactDispositions,
    type LockedReviewFindingPolicyResolution,
    resolveLockedReviewFindingPolicyFromReceiptDisposition
} from '../review/review-finding-disposition';
import {
    countCanonicalReviewSectionHeadings,
    extractMarkdownSectionLines,
    formatAcceptedReviewSectionHeadingShapes,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity,
    getUnsupportedFindingsBySeverityEntries,
    getUnsupportedSeverityHeadingLines
} from './completion-verdict-markdown';

type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

type ReviewArtifactFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tryParseJsonReviewFindingsReport(content: string): {
    detected: boolean;
    report: ReviewFindingsReport | null;
    violations: string[];
} {
    const trimmed = String(content || '').trim();
    if (!trimmed.startsWith('{')) {
        return { detected: false, report: null, violations: [] };
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed) || Number(parsed.schema_version) !== 1 || !isRecord(parsed.findings)) {
            return { detected: false, report: null, violations: [] };
        }
        const coverageLedger = isRecord(parsed.coverage_ledger) ? parsed.coverage_ledger : {};
        const expectedCoverageObligationIds = Array.isArray(coverageLedger.entries)
            ? coverageLedger.entries
                .filter(isRecord)
                .map((entry) => typeof entry.obligation_id === 'string' ? entry.obligation_id.trim() : '')
                .filter(Boolean)
            : [];
        const validation = validateReviewFindingsReport(parsed, {
            expectedTaskId: typeof parsed.task_id === 'string' ? parsed.task_id.trim() : '',
            expectedReviewType: typeof parsed.review_type === 'string' ? parsed.review_type.trim() : '',
            expectedCoverageObligationIds
        });
        return {
            detected: true,
            report: validation.report,
            violations: validation.violations
        };
    } catch {
        return { detected: false, report: null, violations: [] };
    }
}

function jsonFindingEntries(report: ReviewFindingsReport, severity: SeverityLevel): string[] {
    const entries = report.findings[severity];
    return entries
        .map((finding) => {
            const locations = finding.evidence
                .map((entry) => entry.location.trim())
                .filter(Boolean);
            return [finding.id.trim(), finding.title.trim(), ...locations].filter(Boolean).join(' ');
        })
        .filter(Boolean);
}

function jsonResidualRiskEntries(report: ReviewFindingsReport): string[] {
    return report.residual_risks
        .map((risk) => {
            const id = risk.id.trim();
            const description = risk.description.trim();
            return [id, description].filter(Boolean).join(' ');
        })
        .filter(Boolean);
}

export function isTrivialReview(content: string): boolean {
    const text = (content || '').trim();
    if (text.length < 100) return true;
    const hasImplementationReference = text.includes('`')
        || /\b[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?\b/.test(text);

    const lines = text.split('\n');
    const findings = getMarkdownMeaningfulEntries(extractMarkdownSectionLines(lines, 'Findings by Severity'));
    const risks = getMarkdownMeaningfulEntries(extractMarkdownSectionLines(lines, 'Residual Risks'));

    // If both sections are empty of meaningful content, it might be trivial,
    // but we only block if total length is very low or no implementation details are mentioned.
    if (findings.length === 0 && risks.length === 0) {
        const wordCount = text.split(/\s+/).length;
        if (wordCount < 30) return true;
        if (!hasImplementationReference && wordCount < 60) return true;
    }

    return false;
}

export function getReviewArtifactFindingsEvidence(artifactPath: string, content: string) {
    const artifactPathNormalized = normalizePath(artifactPath);
    const result: {
        status: string;
        findings_section_present: boolean;
        residual_risks_section_present: boolean;
        deferred_findings_section_present: boolean;
        findings_by_severity: Record<SeverityLevel, string[]>;
        residual_risks: string[];
        deferred_findings: string[];
        missing_sections: string[];
        invalid_deferred_findings: string[];
        violations: string[];
    } = {
        status: 'UNKNOWN',
        findings_section_present: false,
        residual_risks_section_present: false,
        deferred_findings_section_present: false,
        findings_by_severity: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        deferred_findings: [],
        missing_sections: [],
        invalid_deferred_findings: [],
        violations: []
    };

    const jsonReport = tryParseJsonReviewFindingsReport(content);
    if (jsonReport.detected) {
        result.findings_section_present = true;
        result.residual_risks_section_present = true;
        if (!jsonReport.report) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' contains malformed findings JSON: ${jsonReport.violations.join(' ')}`
            );
            result.status = 'FAILED';
            return result;
        }
        result.findings_by_severity = {
            critical: jsonFindingEntries(jsonReport.report, 'critical'),
            high: jsonFindingEntries(jsonReport.report, 'high'),
            medium: jsonFindingEntries(jsonReport.report, 'medium'),
            low: jsonFindingEntries(jsonReport.report, 'low')
        };
        result.residual_risks = jsonResidualRiskEntries(jsonReport.report);
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            if (result.findings_by_severity[severity].length > 0) {
                const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' still contains active ${severityLabel} findings. ` +
                    "Resolve active defects. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:'; validation-boundary or command/log notes must stay out of strict follow-up sections."
                );
            }
        }
        if (result.residual_risks.length > 0) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains active residual risks. ` +
                "For validation-boundary or command/log notes, set 'Residual Risks' and 'Deferred Findings' to 'None' and keep the note in prose. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:' and will require follow-up tracking."
            );
        }
        result.status = result.violations.length > 0 ? 'FAILED' : 'PASS';
        return result;
    }

    const lines = (content || '').split('\n');

    const headingCounts = countCanonicalReviewSectionHeadings(lines);
    for (const heading of ['Validation Notes', 'Coverage Ledger', 'Findings by Severity', 'Deferred Findings', 'Residual Risks', 'Verdict']) {
        if ((headingCounts[heading] || 0) > 1) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' has ambiguous duplicate section heading for '## ${heading}'. ` +
                formatAcceptedReviewSectionHeadingShapes(heading)
            );
        }
    }

    const findingsStructuralLines = extractMarkdownSectionLines(lines, 'Findings by Severity');
    for (const unsupportedLine of getUnsupportedSeverityHeadingLines(findingsStructuralLines)) {
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' uses unsupported severity heading '${unsupportedLine}' under '## Findings by Severity'. ` +
            "Use parser-supported findings format such as '- Medium: <file:line> <impact>; remediation: <required action>', " +
            "'Medium:' followed by '- <finding>', or '### Medium' followed by '- <finding>'; use canonical 'None' when there are no findings. " +
            "Do not add, remove, rename, reorder, or nest required '##' headings."
        );
    }

    const findingsLines = extractMarkdownSectionLines(lines, 'Findings by Severity');
    if (!findingsLines.length) {
        result.missing_sections.push('Findings by Severity');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Findings by Severity' for lifecycle validation. ` +
            formatAcceptedReviewSectionHeadingShapes('Findings by Severity')
        );
    } else {
        result.findings_section_present = true;
        const findingsBySeverity = getFindingsBySeverity(findingsLines);
        result.findings_by_severity = findingsBySeverity;
        for (const unsupportedEntry of getUnsupportedFindingsBySeverityEntries(findingsLines)) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' contains unsupported meaningful content '${unsupportedEntry}' under '## Findings by Severity'. ` +
                "Use parser-supported findings format such as '- Medium: <file:line> <impact>; remediation: <required action>', " +
                "'Medium:' followed by '- <finding>', or '### Medium' followed by '- <finding>'; use canonical 'None' when there are no findings. " +
                "Unscoped prose, bare severity labels, and bullets without a severity owner are rejected so active findings cannot be hidden."
            );
        }
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            if (findingsBySeverity[severity].length > 0) {
                const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' still contains active ${severityLabel} findings. ` +
                    "Resolve active defects. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:'; validation-boundary or command/log notes must stay out of strict follow-up sections."
                );
            }
        }
    }

    const residualLines = extractMarkdownSectionLines(lines, 'Residual Risks');
    if (!residualLines.length) {
        result.missing_sections.push('Residual Risks');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Residual Risks' for lifecycle validation. ` +
            formatAcceptedReviewSectionHeadingShapes('Residual Risks')
        );
    } else {
        result.residual_risks_section_present = true;
        const residualRisks = getMarkdownMeaningfulEntries(residualLines);
        result.residual_risks = residualRisks;
        if (residualRisks.length > 0) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains active residual risks. ` +
                "For validation-boundary or command/log notes, set 'Residual Risks' and 'Deferred Findings' to 'None' and keep the note in prose. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:' and will require follow-up tracking."
            );
        }
    }

    const deferredLines = extractMarkdownSectionLines(lines, 'Deferred Findings');
    if (deferredLines.length > 0) {
        result.deferred_findings_section_present = true;
        const deferredFindings = getMarkdownMeaningfulEntries(deferredLines);
        result.deferred_findings = deferredFindings;
        for (const entry of deferredFindings) {
            const justificationMatch = /\bJustification\s*:\s*(.+)$/i.exec(entry);
            const justification = justificationMatch ? justificationMatch[1].trim() : '';
            if (!justification || justification.length < 12) {
                result.invalid_deferred_findings.push(entry);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' has deferred finding without usable 'Justification:': ${entry}`
                );
            }
        }
    }

    result.status = result.violations.length > 0 ? 'FAILED' : 'PASS';
    return result;
}

export function getReviewFindingsValidationArtifactEvidence(
    artifactPath: string,
    validationArtifact: ReviewFindingsValidationArtifact | null
): ReturnType<typeof getReviewArtifactFindingsEvidence> {
    const artifactPathNormalized = normalizePath(artifactPath);
    const result: ReturnType<typeof getReviewArtifactFindingsEvidence> = {
        status: 'UNKNOWN',
        findings_section_present: true,
        residual_risks_section_present: true,
        deferred_findings_section_present: false,
        findings_by_severity: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        deferred_findings: [],
        missing_sections: [],
        invalid_deferred_findings: [],
        violations: []
    };
    if (!validationArtifact) {
        result.status = 'FAILED';
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing accepted review findings validation evidence.`
        );
        return result;
    }
    if (!validationArtifact.validation_result.accepted) {
        result.status = 'FAILED';
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' has rejected review findings validation evidence: ` +
            validationArtifact.validation_result.violations.join(' ')
        );
        return result;
    }
    const inventory = validationArtifact.validation_result.normalized_inventory;
    result.findings_by_severity = {
        critical: inventory.findings_by_severity.critical.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        high: inventory.findings_by_severity.high.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        medium: inventory.findings_by_severity.medium.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        low: inventory.findings_by_severity.low.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        )
    };
    result.residual_risks = inventory.residual_risks.map((risk) =>
        [risk.id, risk.description, ...risk.evidence_locations].filter(Boolean).join(' ')
    );
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (result.findings_by_severity[severity].length > 0) {
            const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains active ${severityLabel} findings. ` +
                "Resolve active defects. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:'; validation-boundary or command/log notes must stay out of strict follow-up sections."
            );
        }
    }
    if (result.residual_risks.length > 0) {
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' still contains active residual risks. ` +
            "For validation-boundary or command/log notes, set 'Residual Risks' and 'Deferred Findings' to 'None' and keep the note in prose. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:' and will require follow-up tracking."
        );
    }
    result.status = result.violations.length > 0 ? 'FAILED' : 'PASS';
    return result;
}

export function getReviewFindingsEvidenceFromValidationArtifact(
    artifactPath: string,
    artifact: ReviewFindingsValidationArtifact | null,
    policyResolution: LockedReviewFindingPolicyResolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(null)
): ReviewArtifactFindingsEvidence {
    const artifactPathNormalized = normalizePath(artifactPath);
    const result: ReviewArtifactFindingsEvidence = {
        status: 'UNKNOWN',
        findings_section_present: true,
        residual_risks_section_present: true,
        deferred_findings_section_present: false,
        findings_by_severity: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        deferred_findings: [],
        missing_sections: [],
        invalid_deferred_findings: [],
        violations: []
    };
    if (!artifact) {
        result.status = 'FAILED';
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing accepted findings validation artifact evidence.`
        );
        return result;
    }
    if (!artifact.validation_result.accepted) {
        result.status = 'FAILED';
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' has rejected findings validation artifact evidence: ` +
            artifact.validation_result.violations.join(' ')
        );
        return result;
    }
    const inventory = artifact.validation_result.normalized_inventory;
    result.findings_by_severity = {
        critical: inventory.findings_by_severity.critical.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        high: inventory.findings_by_severity.high.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        medium: inventory.findings_by_severity.medium.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        ),
        low: inventory.findings_by_severity.low.map((finding) =>
            [finding.id, finding.title, ...finding.evidence_locations].filter(Boolean).join(' ')
        )
    };
    result.residual_risks = inventory.residual_risks.map((risk) =>
        [risk.id, risk.description, ...risk.evidence_locations].filter(Boolean).join(' ')
    );
    const disposition = evaluateReviewFindingsValidationArtifactDispositions(artifact, policyResolution);
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (disposition.findings[severity].action === 'fix_now' && disposition.findings[severity].count > 0) {
            const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains fix_now ${severityLabel} findings in accepted findings validation artifact. ` +
                'Fix implementation and rerun the affected review before completing the task.'
            );
        }
    }
    if (disposition.residual_risks.action === 'fix_now' && disposition.residual_risks.count > 0) {
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' still contains fix_now residual risks in accepted findings validation artifact. ` +
            'Resolve or explicitly disposition residual risks before completing the task.'
        );
    }
    result.status = result.violations.length > 0 ? 'FAILED' : 'PASS';
    return result;
}
