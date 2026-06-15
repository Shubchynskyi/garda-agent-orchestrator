import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../../gates/shared/helpers';
import type { ReportDataUnavailableEntry, ReportValueRow } from './types';

export function toRepoRelativePath(repoRoot: string, filePath: string): string {
    const root = path.resolve(repoRoot);
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return toPosix(relative || '.');
    }
    return toPosix(resolved);
}

export function valueRow(
    id: string,
    label: string,
    description: string,
    value: unknown,
    filePath?: string | null
): ReportValueRow {
    return {
        id,
        label,
        description,
        value: value ?? null,
        ...(filePath ? { file_path: filePath } : {})
    };
}

export function pickRows(source: Record<string, unknown>, rows: Array<[string, string, string]>): ReportValueRow[] {
    return rows.map(([id, label, description]) => valueRow(id, label, description, source[id]));
}

export function readJsonObjectForReport(
    repoRoot: string,
    filePath: string,
    scope: string,
    unavailable: ReportDataUnavailableEntry[]
): { status: 'present' | 'missing' | 'invalid'; value: Record<string, unknown> } {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        unavailable.push({ scope, reason: `${toRepoRelativePath(repoRoot, filePath)} not found.` });
        return { status: 'missing', value: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON root is not an object.');
        }
        return { status: 'present', value: parsed as Record<string, unknown> };
    } catch (error: unknown) {
        unavailable.push({
            scope,
            reason: error instanceof Error ? error.message : String(error)
        });
        return { status: 'invalid', value: {} };
    }
}

export function readJsonObject(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function formatDurationMs(durationMs: number | null): string | null {
    if (durationMs == null) {
        return null;
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    const secondsText = (seconds: number): string => seconds.toFixed(1).replace(/\.0$/, '');
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${secondsText(totalSeconds)}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds - totalMinutes * 60;
    if (totalMinutes < 60) {
        return `${totalMinutes}m ${secondsText(remainingSeconds)}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ${secondsText(remainingSeconds)}s`;
}

export function formatSizeBytes(sizeBytes: number): string {
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
        return '0 B';
    }
    if (sizeBytes < 1024) {
        return `${sizeBytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = sizeBytes;
    let unitIndex = -1;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = value >= 10 || unitIndex === 0
        ? Math.round(value)
        : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
}

export function statFingerprint(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return `${filePath}:missing`;
        }
        throw error;
    }
}
