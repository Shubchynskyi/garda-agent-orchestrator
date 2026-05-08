import {
    bold,
    cyan,
    dim,
    green,
    red,
    supportsColor,
    yellow
} from './cli-helpers';

function colorStatus(value: string): string {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'PASS' || normalized === 'PASSED' || normalized === 'READY' || normalized === 'CURRENT' || normalized === 'UPDATED') {
        return green(value);
    }
    if (normalized === 'FAIL' || normalized === 'FAILED' || normalized === 'BLOCKED' || normalized === 'INCOMPLETE' || normalized === 'NOT_READY') {
        return red(value);
    }
    if (normalized === 'WARN' || normalized === 'WARNING' || normalized === 'MISSING') {
        return yellow(value);
    }
    if (normalized === 'SKIP' || normalized === 'SKIPPED' || normalized === 'ABSENT') {
        return dim(value);
    }
    return value;
}

function colorKeyValueLine(line: string): string {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) return line;
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trimStart();
    const spacing = line.slice(separatorIndex + 1, line.length - value.length);

    if (key === 'Task') return `${bold(`${key}:`)}${spacing}${cyan(value)}`;
    if (key === 'Status' || key === 'Integrity' || key === 'FinalReportContract') {
        return `${bold(`${key}:`)}${spacing}${colorStatus(value)}`;
    }
    if (key === 'FinalCloseout') {
        const match = value.match(/^(\S+)(.*)$/);
        return `${bold(`${key}:`)}${spacing}${match ? `${colorStatus(match[1])}${dim(match[2] || '')}` : value}`;
    }
    if (key.endsWith('Artifact') || key === 'Reason' || key === 'RecommendedAction') {
        return `${bold(`${key}:`)}${spacing}${dim(value)}`;
    }
    return `${bold(`${key}:`)}${spacing}${value}`;
}

function colorMarkerLine(line: string): string {
    const match = line.match(/^(\s*)(\[\+\]|\[X\]|\[ \]|\[!\]|\[=\]|\[-\])(\s+)(.*)$/);
    if (!match) return line;
    const [, indent, marker, spacing, rest] = match;
    const coloredMarker = marker === '[+]' ? green(marker)
        : marker === '[X]' ? red(marker)
            : marker === '[!]' ? yellow(marker)
                : marker === '[ ]' ? dim(marker)
                    : cyan(marker);
    const coloredRest = marker === '[ ]' ? dim(rest) : rest;
    return `${indent}${coloredMarker}${spacing}${coloredRest}`;
}

function colorAuditLine(line: string): string {
    if (!line.trim()) return line;
    if (
        line === 'Gates:'
        || line === 'Blockers:'
        || line.startsWith('Evidence (')
        || line === 'ProfileReviewDecisions:'
        || line === 'ReviewIntegrityIssues:'
        || line === 'FinalReportOrder:'
    ) {
        return bold(line);
    }
    if (line.trimStart().match(/^(\[\+\]|\[X\]|\[ \]|\[!\]|\[=\]|\[-\])\s+/)) {
        return colorMarkerLine(line);
    }
    if (line.trimStart().startsWith('- ')) return yellow(line);
    if (line.includes('Review trust: INDEPENDENT_AUDITED')) return green(line);
    if (line.includes('Review integrity:') && line.includes('completion_allowed=yes')) return green(line);
    if (line.includes('Review integrity:') || line.includes('Review trust:')) return yellow(line);
    if (line.startsWith('Suppressed output:')) return green(line);
    if (line.includes(':')) return colorKeyValueLine(line);
    return line;
}

export function colorizeTaskAuditSummaryText(rendered: string): string {
    if (!supportsColor()) return rendered;
    return rendered
        .split('\n')
        .map((line) => colorAuditLine(line))
        .join('\n');
}
