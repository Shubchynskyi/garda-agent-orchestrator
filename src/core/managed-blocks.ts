import { ensureTrailingLineEnding, normalizeLineEndings } from './line-endings';

export interface ManagedBlockOptions {
    startMarker: string;
    endMarker: string;
    blockLines?: string[];
    newline?: string;
}

export interface ManagedSpan {
    start: number;
    end: number;
}

export type OwnershipKind = 'managed' | 'user';

export interface OwnershipRegion {
    kind: OwnershipKind;
    start: number;
    end: number;
    text: string;
}

export function buildManagedBlock(startMarker: string, endMarker: string, blockLines: string | string[], newline: string = '\n'): string {
    const lines = Array.isArray(blockLines) ? blockLines.map((line) => String(line)) : [String(blockLines)];
    return [startMarker, ...lines, endMarker].join(newline);
}

/**
 * Find the span covering `startMarker...endMarker` inside `text`.
 * Returns `{ start, end }` indices or `undefined` when the markers are absent.
 * The span includes an optional leading `\n` before the start marker and an
 * optional trailing `\n` after the end marker so callers can slice cleanly.
 */
export function findManagedSpan(text: string, startMarker: string, endMarker: string, includePeripheralNewlines: boolean): ManagedSpan | undefined {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return undefined;

    const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx === -1) return undefined;

    let spanStart = startIdx;
    let spanEnd = endIdx + endMarker.length;

    if (includePeripheralNewlines) {
        if (spanStart > 0 && text[spanStart - 1] === '\n') spanStart--;
        if (spanEnd < text.length && text[spanEnd] === '\n') spanEnd++;
    }

    return { start: spanStart, end: spanEnd };
}

/**
 * Extract the text inside a managed block (between start and end markers inclusive).
 * Returns `null` when no managed block is found.
 */
export function extractManagedContent(text: string, startMarker: string, endMarker: string): string | null {
    const span = findManagedSpan(text, startMarker, endMarker, false);
    if (!span) return null;
    return text.slice(span.start, span.end);
}

/**
 * Extract the user-owned content (everything outside managed blocks).
 * Returns the concatenated user-owned portions of the text.
 */
export function extractUserContent(text: string, startMarker: string, endMarker: string): string {
    const span = findManagedSpan(text, startMarker, endMarker, false);
    if (!span) return text;
    return text.slice(0, span.start) + text.slice(span.end);
}

/**
 * Classify every region of `text` as either `managed` or `user`-owned.
 * Returns an ordered array of non-overlapping regions covering the full text.
 * Empty regions are omitted.
 */
export function classifyOwnership(text: string, startMarker: string, endMarker: string): OwnershipRegion[] {
    const regions: OwnershipRegion[] = [];
    const span = findManagedSpan(text, startMarker, endMarker, false);

    if (!span) {
        if (text.length > 0) {
            regions.push({ kind: 'user', start: 0, end: text.length, text });
        }
        return regions;
    }

    if (span.start > 0) {
        regions.push({ kind: 'user', start: 0, end: span.start, text: text.slice(0, span.start) });
    }
    regions.push({ kind: 'managed', start: span.start, end: span.end, text: text.slice(span.start, span.end) });
    if (span.end < text.length) {
        regions.push({ kind: 'user', start: span.end, end: text.length, text: text.slice(span.end) });
    }

    return regions;
}

export function upsertManagedBlock(content: string, options: ManagedBlockOptions): string {
    const newline = options.newline || '\n';
    const normalized = normalizeLineEndings(content || '', '\n');
    const block = buildManagedBlock(options.startMarker, options.endMarker, options.blockLines || [], '\n');
    let result: string;

    const span = findManagedSpan(normalized, options.startMarker, options.endMarker, false);
    if (span) {
        result = normalized.slice(0, span.start) + block + normalized.slice(span.end);
    } else if (normalized.trim().length === 0) {
        result = block;
    } else {
        result = ensureTrailingLineEnding(normalized, '\n') + block;
    }

    return ensureTrailingLineEnding(normalizeLineEndings(result, newline), newline);
}

export function removeManagedBlock(content: string, options: ManagedBlockOptions): string {
    const newline = options.newline || '\n';
    const normalized = normalizeLineEndings(content || '', '\n');

    const span = findManagedSpan(normalized, options.startMarker, options.endMarker, true);
    if (!span) return normalizeLineEndings(normalized, newline);

    const result = (normalized.slice(0, span.start) + '\n' + normalized.slice(span.end))
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n/, '');

    return normalizeLineEndings(result, newline);
}

