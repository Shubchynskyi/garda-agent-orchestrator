import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Central redaction utilities for stripping secrets and sensitive host details
 * from diagnostics, artifacts, and user-facing output.
 *
 * Redaction is deterministic: the same input always produces the same redacted
 * token within a single process lifetime, enabling correlation in diagnostic
 * output without leaking real values.
 */

// ---------------------------------------------------------------------------
// Short deterministic token (first 8 hex chars of SHA-256)
// ---------------------------------------------------------------------------

function shortHash(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex').substring(0, 8);
}

// ---------------------------------------------------------------------------
// Hostname redaction
// ---------------------------------------------------------------------------

/**
 * Replace a hostname with a deterministic redacted token.
 * Null/empty values pass through unchanged (they carry no sensitive signal).
 */
export function redactHostname(hostname: string | null | undefined): string | null {
    if (hostname == null) {
        return null;
    }
    const trimmed = String(hostname).trim();
    if (!trimmed) {
        return null;
    }
    return `<host-${shortHash(trimmed)}>`;
}

// ---------------------------------------------------------------------------
// Username / home-directory redaction
// ---------------------------------------------------------------------------

let cachedHomedir: string | null = null;
let cachedUsername: string | null = null;

function getHomedir(): string {
    if (cachedHomedir === null) {
        try {
            cachedHomedir = os.homedir();
        } catch {
            cachedHomedir = '';
        }
    }
    return cachedHomedir;
}

function getUsername(): string {
    if (cachedUsername === null) {
        try {
            cachedUsername = os.userInfo().username;
        } catch {
            cachedUsername = '';
        }
    }
    return cachedUsername;
}

// ---------------------------------------------------------------------------
// Path redaction
// ---------------------------------------------------------------------------

/**
 * Redact absolute paths that may reveal user home directories or usernames.
 *
 * When `repoRoot` is supplied, paths under the repo root are relativized
 * instead of fully redacted to preserve diagnostic utility.
 */
export function redactPath(absolutePath: string, repoRoot?: string): string {
    if (!absolutePath || typeof absolutePath !== 'string') {
        return absolutePath;
    }

    const normalized = absolutePath.replace(/\\/g, '/');

    // If we have a repo root, try to relativize the path first —
    // repo-relative paths are safe to display.
    if (repoRoot) {
        const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
        if (normalized === normalizedRoot) {
            return '.';
        }
        const rootPrefix = normalizedRoot + '/';
        if (normalized.startsWith(rootPrefix)) {
            return normalized.slice(rootPrefix.length);
        }
        // Case-insensitive comparison for Windows
        if (normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
            return normalized.slice(rootPrefix.length);
        }
    }

    // Redact the user home-directory prefix if present.
    const homedir = getHomedir().replace(/\\/g, '/');
    if (homedir) {
        const homePrefix = homedir.endsWith('/') ? homedir : homedir + '/';
        if (normalized.startsWith(homePrefix) || normalized.toLowerCase().startsWith(homePrefix.toLowerCase())) {
            return `<home>/${normalized.slice(homePrefix.length)}`;
        }
        if (normalized === homedir || normalized.toLowerCase() === homedir.toLowerCase()) {
            return '<home>';
        }
    }

    // Fallback: redact any leading path segment that matches the username.
    const username = getUsername();
    if (username) {
        const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernamePattern = new RegExp(`([/\\\\])${escapedUsername}([/\\\\]|$)`, 'gi');
        if (usernamePattern.test(normalized)) {
            return normalized.replace(usernamePattern, `$1<user>$2`);
        }
    }

    return absolutePath;
}

// ---------------------------------------------------------------------------
// Environment-variable secret patterns
// ---------------------------------------------------------------------------

const SECRET_ENV_PATTERNS: RegExp[] = [
    /(?:secret|token|password|credential|api[_-]?key|auth|private[_-]?key)/i,
];

/**
 * Redact environment variable values that look like secrets based on key name.
 * Returns a new object with sensitive values replaced by `<redacted>`.
 */
export function redactEnvObject(env: Record<string, string | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            continue;
        }
        const isSensitive = SECRET_ENV_PATTERNS.some((p) => p.test(key));
        result[key] = isSensitive ? '<redacted>' : value;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Diagnostic text redaction
// ---------------------------------------------------------------------------

/**
 * Scrub a free-form diagnostic string of hostnames, home-directory paths,
 * and usernames. Best-effort: applies known-value replacement only.
 */
export function redactDiagnosticText(text: string, repoRoot?: string): string {
    if (!text || typeof text !== 'string') {
        return text;
    }

    let result = text;

    // Replace the real hostname with a redacted token.
    let currentHostname: string;
    try {
        currentHostname = os.hostname();
    } catch {
        currentHostname = '';
    }
    if (currentHostname) {
        const hostToken = redactHostname(currentHostname)!;
        result = replaceAll(result, currentHostname, hostToken);
    }

    // Replace home-directory prefix.
    const homedir = getHomedir();
    if (homedir) {
        const forwardSlash = homedir.replace(/\\/g, '/');
        const backSlash = homedir.replace(/\//g, '\\');
        result = replaceAll(result, forwardSlash, '<home>');
        if (backSlash !== forwardSlash) {
            result = replaceAll(result, backSlash, '<home>');
        }
    }

    // Replace bare username occurrences that form a path segment.
    const username = getUsername();
    if (username && username.length >= 2) {
        const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const segmentPattern = new RegExp(`([/\\\\])${escapedUsername}([/\\\\])`, 'gi');
        result = result.replace(segmentPattern, '$1<user>$2');
    }

    // Redact paths relative to repo root last so earlier replacements take effect first.
    if (repoRoot) {
        const normalizedRoot = repoRoot.replace(/\\/g, '/');
        const backSlashRoot = repoRoot.replace(/\//g, '\\');
        if (normalizedRoot.length > 3) {
            result = replaceAll(result, normalizedRoot, '<repo>');
        }
        if (backSlashRoot !== normalizedRoot && backSlashRoot.length > 3) {
            result = replaceAll(result, backSlashRoot, '<repo>');
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// RedactionContext – reusable per-task/per-gate redaction scope
// ---------------------------------------------------------------------------

export interface RedactionContext {
    readonly repoRoot: string | undefined;
    redactHostname(hostname: string | null | undefined): string | null;
    redactPath(absolutePath: string): string;
    redactDiagnosticText(text: string): string;
}

/**
 * Build a reusable redaction context scoped to a repository root.
 */
export function createRedactionContext(repoRoot?: string): RedactionContext {
    return {
        repoRoot,
        redactHostname(hostname: string | null | undefined): string | null {
            return redactHostname(hostname);
        },
        redactPath(absolutePath: string): string {
            return redactPath(absolutePath, repoRoot);
        },
        redactDiagnosticText(text: string): string {
            return redactDiagnosticText(text, repoRoot);
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function replaceAll(source: string, search: string, replacement: string): string {
    if (!search) {
        return source;
    }
    // Case-insensitive replacement for path segments that may differ in casing.
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.replace(new RegExp(escaped, 'gi'), replacement);
}

// For testing: reset cached values (not exported at module level).
export function _resetCachedValues(): void {
    cachedHomedir = null;
    cachedUsername = null;
}
