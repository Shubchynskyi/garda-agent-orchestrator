import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { assertCanonicalTaskId } from '../core/task-ids';
import { stringSha256 } from './hash';

// Root module retained for mutable CommonJS test hooks; timeline exports re-route grouped imports.
const JSONL_READ_CHUNK_SIZE = 64 * 1024;

export function toTrimmedString(value: unknown): string {
    return value ? String(value).trim() : '';
}

export function toTrimmedLowerCaseString(value: unknown): string {
    return value ? String(value).trim().toLowerCase() : '';
}

export function assertValidTaskId(value: unknown): string {
    return assertCanonicalTaskId(value);
}

export function buildEventIntegrityHash(eventObj: Record<string, unknown>): string | null {
    const normalizedEvent: Record<string, unknown> = Object.assign({}, eventObj);
    const integrity = normalizedEvent.integrity;
    if (integrity && typeof integrity === 'object') {
        const normalizedIntegrity: Record<string, unknown> = Object.assign({}, integrity as Record<string, unknown>);
        delete normalizedIntegrity.event_sha256;
        normalizedEvent.integrity = normalizedIntegrity;
    }

    const canonicalPayload = JSON.stringify(normalizeIntegrityValue(normalizedEvent));
    return stringSha256(canonicalPayload);
}

export function forEachJsonlLine(
    filePath: string,
    callback: (line: string, lineNumber: number) => void | false
): number {
    let fd: number | null = null;
    try {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return 0;
        }
        if (!stat.isFile() || stat.size === 0) {
            return 0;
        }

        fd = fs.openSync(filePath, 'r');
        const fileSize = stat.size;
        const buf = Buffer.alloc(Math.min(JSONL_READ_CHUNK_SIZE, fileSize));
        const decoder = new StringDecoder('utf8');
        let offset = 0;
        let remainder = '';
        let lineIndex = 0;
        let stopped = false;

        while (offset < fileSize && !stopped) {
            const toRead = Math.min(buf.length, fileSize - offset);
            const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;

            const decoded = decoder.write(buf.subarray(0, bytesRead));
            const chunk = remainder + decoded;
            const lines = chunk.split('\n');
            remainder = lines.pop() || '';

            for (const rawLine of lines) {
                lineIndex++;
                if (!rawLine.trim()) continue;
                if (callback(rawLine, lineIndex) === false) {
                    stopped = true;
                    break;
                }
            }
        }

        if (!stopped) {
            const flushed = decoder.end();
            if (flushed) {
                remainder += flushed;
            }
        }

        if (!stopped && remainder.trim()) {
            lineIndex++;
            callback(remainder, lineIndex);
        }

        return lineIndex;
    } finally {
        if (fd != null) {
            try { fs.closeSync(fd); } catch { /* best-effort */ }
        }
    }
}

function normalizeIntegrityValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(normalizeIntegrityValue);
    }

    if (typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        for (const key of keys) {
            sorted[key] = normalizeIntegrityValue(obj[key]);
        }
        return sorted;
    }

    if (typeof value === 'string' && value.includes('\\')) {
        return value.replace(/\\/g, '/');
    }

    return value;
}
