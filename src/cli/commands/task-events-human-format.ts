import { isOutputCompactionSummaryLine } from '../../gate-runtime/output-compaction-reporting';
import {
    bold,
    cyan,
    dim,
    green,
    red,
    supportsColor,
    yellow
} from './cli-helpers';

function colorOutcome(outcome: string): string {
    const normalized = outcome.trim().toUpperCase();
    if (normalized === 'PASS' || normalized === 'PASSED') return green(outcome);
    if (normalized === 'FAIL' || normalized === 'FAILED' || normalized === 'BLOCKED') return red(outcome);
    if (normalized === 'WARN' || normalized === 'WARNING') return yellow(outcome);
    if (normalized === 'SKIP' || normalized === 'SKIPPED') return dim(outcome);
    if (normalized === 'INFO') return cyan(outcome);
    return outcome;
}

function colorKeyValueLine(line: string): string {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) return line;
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trimStart();
    const spacing = line.slice(separatorIndex + 1, line.length - value.length);

    if (key === 'IntegrityStatus') {
        return `${bold(`${key}:`)}${spacing}${colorOutcome(value)}`;
    }
    if (key === 'Source') {
        return `${bold(`${key}:`)}${spacing}${dim(value)}`;
    }
    if (key === 'ParseErrors' || key === 'IntegrityViolations') {
        return `${bold(`${key}:`)}${spacing}${red(value)}`;
    }
    if (key === 'CommandPolicyWarnings') {
        return `${bold(`${key}:`)}${spacing}${yellow(value)}`;
    }
    if (key === 'Task') {
        return `${bold(`${key}:`)}${spacing}${cyan(value)}`;
    }
    return `${bold(`${key}:`)}${spacing}${value}`;
}

function colorTimelineLine(line: string): string {
    const match = line.match(/^(\[\d+\])\s+([^|]*?)\s+\|\s+([^|]*?)\s+\|\s+([^|]*?)(\s+\|.*)?$/);
    if (!match) return line;
    const [, index, timestamp, eventType, outcome, rest = ''] = match;
    return `${dim(index)} ${dim(timestamp.trim())} | ${cyan(eventType.trim())} | ${colorOutcome(outcome.trim())}${dim(rest)}`;
}

function colorLine(line: string): string {
    if (!line.trim()) return line;
    if (line === 'Timeline:' || line === 'IntegrityViolations:' || line === 'CommandPolicyWarnings:') {
        return bold(line);
    }
    if (line.startsWith('[')) return colorTimelineLine(line);
    if (line.trimStart().startsWith('details=')) return dim(line);
    if (line.startsWith('- ')) return yellow(line);
    if (isOutputCompactionSummaryLine(line)) return green(line);
    if (line.includes(':')) return colorKeyValueLine(line);
    return line;
}

export function colorizeTaskEventsSummaryText(rendered: string): string {
    if (!supportsColor()) return rendered;
    return rendered
        .split('\n')
        .map((line) => colorLine(line))
        .join('\n');
}
