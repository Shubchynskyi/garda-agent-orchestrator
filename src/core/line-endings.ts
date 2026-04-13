export function detectLineEnding(text: string): string {
    return String(text).includes('\r\n') ? '\r\n' : '\n';
}

export function normalizeLineEndings(text: string, newline: string = '\n'): string {
    return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, newline);
}

export function ensureTrailingLineEnding(text: string, newline: string = '\n'): string {
    const normalized = normalizeLineEndings(text, newline);
    return normalized.endsWith(newline) ? normalized : `${normalized}${newline}`;
}

