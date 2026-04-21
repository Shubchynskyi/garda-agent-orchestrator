import { ErrorGroup, GroupingResult } from './types';

// Strip file paths, line/column numbers, and leading whitespace to extract
// the core error signature from a diagnostic line.
// Requires at least one directory separator to avoid matching bare words.
const PATH_PREFIX_RE = /^(?:[A-Za-z]:)?[/\\]?(?:[\w.@-]+[/\\])+[\w.@-]+(?::\d+(?::\d+)?)?[:\s]+/;
const LINE_COL_RE = /\(\d+,\d+\)/g;
const ANON_PATH_RE = /(?:[A-Za-z]:)?(?:[/\\][\w.@-]+){2,}/g;

export function normalizeErrorSignature(line: string): string {
    let sig = line.trim();
    sig = sig.replace(PATH_PREFIX_RE, '');
    sig = sig.replace(LINE_COL_RE, '');
    sig = sig.replace(ANON_PATH_RE, '<path>');
    sig = sig.replace(/\s{2,}/g, ' ').trim();
    return sig || line.trim();
}

export function groupMatchingLines(
    lines: string[],
    patterns: string[],
    maxGroups: number
): GroupingResult {
    const compiledPatterns = patterns.map((p) => new RegExp(p));
    const groupMap = new Map<string, ErrorGroup>();
    const groupOrder: string[] = [];
    let totalMatches = 0;

    for (const line of lines) {
        if (!compiledPatterns.some((p) => p.test(line))) {
            continue;
        }
        totalMatches++;
        const sig = normalizeErrorSignature(line);
        const existing = groupMap.get(sig);
        if (existing) {
            existing.count++;
        } else {
            const group: ErrorGroup = { signature: sig, representative: line, count: 1 };
            groupMap.set(sig, group);
            groupOrder.push(sig);
        }
    }

    const limitedKeys = maxGroups > 0 ? groupOrder.slice(0, maxGroups) : groupOrder;
    const groups: ErrorGroup[] = limitedKeys.map((k) => groupMap.get(k)!);
    return { groups, total_matches: totalMatches, unique_groups: groupOrder.length };
}

export function formatGroupedLines(result: GroupingResult): string[] {
    const output: string[] = [];
    for (const group of result.groups) {
        if (group.count > 1) {
            output.push(`[${group.count}×] ${group.representative}`);
        } else {
            output.push(group.representative);
        }
    }
    if (result.unique_groups > result.groups.length) {
        const omitted = result.unique_groups - result.groups.length;
        output.push(`... and ${omitted} more distinct error(s) (${result.total_matches} total matches)`);
    } else if (result.total_matches > result.groups.reduce((s, g) => s + g.count, 0)) {
        // Should not normally happen, but guard for clarity
        output.push(`(${result.total_matches} total matches)`);
    }
    return output;
}
