export const EMPTY_REVIEW_MARKERS = new Set([
    'none', 'n/a', 'na', 'no findings', 'no residual risks',
    'no deferred findings', 'no open findings', 'no outstanding findings'
]);

export const CANONICAL_REVIEW_SECTION_HEADINGS = [
    'Findings by Severity',
    'Deferred Findings',
    'Residual Risks',
    'Verdict'
] as const;

const CANONICAL_REVIEW_SECTION_HEADING_LOOKUP = new Map(
    CANONICAL_REVIEW_SECTION_HEADINGS.map((heading) => [heading.toLowerCase(), heading])
);

export function formatAcceptedReviewSectionHeadingShapes(heading: string): string {
    return `Accepted section heading shapes include '## ${heading}', '**${heading}**', and '## **${heading}**'.`;
}

function stripOuterBoldMarkdown(value: string): { text: string; stripped: boolean } {
    const match = /^(?:\*\*|__)\s*(.+?)\s*(?:\*\*|__)$/.exec(value.trim());
    return match ? { text: match[1].trim(), stripped: true } : { text: value, stripped: false };
}

function stripHashMarkdownHeading(value: string): { text: string; stripped: boolean } {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(value.trim());
    return match ? { text: match[2].trim(), stripped: true } : { text: value, stripped: false };
}

export function getCanonicalReviewSectionHeading(rawLine: unknown): string | null {
    let text = String(rawLine || '').trim();
    if (!text) {
        return null;
    }

    let sawHeadingSyntax = false;
    for (let index = 0; index < 4; index += 1) {
        const bold = stripOuterBoldMarkdown(text);
        if (bold.stripped) {
            text = bold.text;
            sawHeadingSyntax = true;
            continue;
        }
        const hash = stripHashMarkdownHeading(text);
        if (hash.stripped) {
            text = hash.text;
            sawHeadingSyntax = true;
            continue;
        }
        break;
    }
    if (!sawHeadingSyntax) {
        return null;
    }

    return CANONICAL_REVIEW_SECTION_HEADING_LOOKUP.get(text.toLowerCase()) || null;
}

export function countCanonicalReviewSectionHeadings(lines: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const rawLine of lines) {
        const heading = getCanonicalReviewSectionHeading(rawLine);
        if (heading) {
            counts[heading] = (counts[heading] || 0) + 1;
        }
    }
    return counts;
}

export function normalizeCanonicalReviewSectionHeadings(content: string): { content: string; changed: boolean } {
    const lines = String(content || '').split('\n');
    let changed = false;
    const normalizedLines = lines.map((line) => {
        const heading = getCanonicalReviewSectionHeading(line);
        if (!heading) {
            return line;
        }
        const canonicalLine = `## ${heading}`;
        if (line.trim() !== canonicalLine) {
            changed = true;
        }
        return canonicalLine;
    });
    return {
        content: normalizedLines.join('\n'),
        changed
    };
}

export function extractMarkdownSectionLines(lines: string[], heading: string): string[] {
    const sectionLines: string[] = [];
    let capture = false;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const canonicalHeading = getCanonicalReviewSectionHeading(trimmed);
        const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(trimmed);
        if (canonicalHeading || headingMatch) {
            if (capture) break;
            capture = canonicalHeading
                ? canonicalHeading.toLowerCase() === heading.trim().toLowerCase()
                : headingMatch?.[2].trim().toLowerCase() === heading.trim().toLowerCase();
            continue;
        }
        if (capture) sectionLines.push(rawLine);
    }
    return sectionLines;
}

export function normalizeReviewListText(value: unknown): string {
    if (value == null) return '';
    let text = String(value).trim();
    text = text.replace(/^(?:[-*+]\s+|\d+\.\s+)+/, '').trim();
    while (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

export function isMeaningfulReviewEntry(value: unknown): boolean {
    const text = normalizeReviewListText(value);
    if (!text) return false;
    const normalized = text.trim().replace(/\.$/, '').trim().replace(/^`|`$/g, '').trim().toLowerCase();
    return !EMPTY_REVIEW_MARKERS.has(normalized);
}

export function getMarkdownMeaningfulEntries(sectionLines: string[]): string[] {
    const entries: string[] = [];
    let currentEntry: string | null = null;

    for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const bulletMatch = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(trimmed);
        if (bulletMatch) {
            if (isMeaningfulReviewEntry(currentEntry)) {
                entries.push(normalizeReviewListText(currentEntry));
            }
            const candidate = normalizeReviewListText(bulletMatch[1]);
            currentEntry = isMeaningfulReviewEntry(candidate) ? candidate : null;
            continue;
        }

        const candidate = normalizeReviewListText(trimmed);
        if (!isMeaningfulReviewEntry(candidate)) continue;
        currentEntry = currentEntry ? `${currentEntry} ${candidate}`.trim() : candidate;
    }

    if (isMeaningfulReviewEntry(currentEntry)) {
        entries.push(normalizeReviewListText(currentEntry));
    }

    return entries;
}

type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export function getFindingsBySeverity(sectionLines: string[]): Record<SeverityLevel, string[]> {
    const findings: Record<SeverityLevel, string[]> = { critical: [], high: [], medium: [], low: [] };
    let currentSeverity: SeverityLevel | null = null;

    for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const severityMatch = /^(?:[-*+]\s*)?(Critical|High|Medium|Low)\s*:\s*(.*)$/i.exec(trimmed);
        if (severityMatch) {
            currentSeverity = severityMatch[1].trim().toLowerCase() as SeverityLevel;
            const remainder = normalizeReviewListText(severityMatch[2]);
            if (isMeaningfulReviewEntry(remainder)) {
                findings[currentSeverity].push(remainder);
            }
            continue;
        }

        if (!currentSeverity) continue;

        const bulletMatch = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(trimmed);
        if (bulletMatch) {
            const entry = normalizeReviewListText(bulletMatch[1]);
            if (isMeaningfulReviewEntry(entry)) {
                findings[currentSeverity].push(entry);
            }
            continue;
        }

        const entry = normalizeReviewListText(trimmed);
        if (!isMeaningfulReviewEntry(entry)) continue;
        if (findings[currentSeverity].length > 0) {
            findings[currentSeverity][findings[currentSeverity].length - 1] =
                `${findings[currentSeverity][findings[currentSeverity].length - 1]} ${entry}`.trim();
        } else {
            findings[currentSeverity].push(entry);
        }
    }

    return findings;
}
