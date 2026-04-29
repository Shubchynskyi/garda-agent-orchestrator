import { normalizePath } from './helpers';
import {
    extractMarkdownSectionLines,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity
} from './completion-verdict-markdown';

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
    type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';
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

    const lines = (content || '').split('\n');

    const findingsLines = extractMarkdownSectionLines(lines, 'Findings by Severity');
    if (!findingsLines.length) {
        result.missing_sections.push('Findings by Severity');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Findings by Severity' for lifecycle validation.`
        );
    } else {
        result.findings_section_present = true;
        const findingsBySeverity = getFindingsBySeverity(findingsLines);
        result.findings_by_severity = findingsBySeverity;
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            if (findingsBySeverity[severity].length > 0) {
                const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' still contains active ${severityLabel} findings. ` +
                    "Resolve them or move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:'."
                );
            }
        }
    }

    const residualLines = extractMarkdownSectionLines(lines, 'Residual Risks');
    if (!residualLines.length) {
        result.missing_sections.push('Residual Risks');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Residual Risks' for lifecycle validation.`
        );
    } else {
        result.residual_risks_section_present = true;
        const residualRisks = getMarkdownMeaningfulEntries(residualLines);
        result.residual_risks = residualRisks;
        if (residualRisks.length > 0) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains active residual risks. ` +
                "Move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:' before DONE."
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
