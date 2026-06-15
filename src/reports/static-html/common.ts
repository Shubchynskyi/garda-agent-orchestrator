import * as path from 'node:path';

export interface StaticHtmlRenderContext {
    repoRoot: string;
    outputPath: string;
}

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeJsonForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

export function formatDuration(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return '-';
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

export function toStaticRepoFileHref(context: StaticHtmlRenderContext, repoPath: string): string | null {
    const repoRoot = path.resolve(context.repoRoot);
    const outputDir = path.dirname(path.resolve(context.outputPath));
    const requestedPath = path.isAbsolute(repoPath)
        ? path.resolve(repoPath)
        : path.resolve(repoRoot, repoPath);
    const relativeToRepo = path.relative(repoRoot, requestedPath);
    if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
        return null;
    }
    const relativeToReport = path.relative(outputDir, requestedPath).split(path.sep).join('/');
    return encodeURI(relativeToReport || '.');
}

export function renderUnavailableList(
    entries: Array<{ scope: string; reason: string }>
): string {
    if (entries.length === 0) {
        return '';
    }
    return [
        '<section class="card unavailable">',
        '<h3>Unavailable Data</h3>',
        '<ul>',
        ...entries.map(
            (entry) => `<li><strong>${escapeHtml(entry.scope)}</strong>: ${escapeHtml(entry.reason)}</li>`
        ),
        '</ul>',
        '</section>'
    ].join('');
}
