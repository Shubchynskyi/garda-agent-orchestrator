export const ORDINARY_DOC_PATHS_CONFIG_KEY = 'ordinary_doc_paths';
export const DEFAULT_ORDINARY_DOC_PATHS = Object.freeze(['CHANGELOG.md']);

export interface OrdinaryDocPathMatch {
    path: string;
    pattern: string;
}

export interface OrdinaryDocPathMatcher {
    pattern: string;
    regex: RegExp;
}

interface NormalizeOrdinaryDocPathsOptions {
    allowScalar?: boolean;
}

const MATCHER_CACHE_MAX_ENTRIES = 64;
const matcherCacheByKey = new Map<string, readonly OrdinaryDocPathMatcher[]>();

function normalizePathText(value: string): string {
    return value
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '')
        .trim();
}

function hasLiteralPathCharacter(pattern: string): boolean {
    return /[A-Za-z0-9._-]/.test(pattern);
}

function startsWithWildcardSegment(pattern: string): boolean {
    const firstSegment = pattern.split('/').filter(Boolean)[0] || '';
    return /[*?]/.test(firstSegment);
}

function isRepositoryWideWildcardPattern(pattern: string): boolean {
    return pattern === '*'
        || pattern === '**'
        || pattern === '**/*'
        || pattern === '*/**'
        || startsWithWildcardSegment(pattern);
}

export function normalizeOrdinaryDocPathPattern(value: unknown, fieldName: string): string {
    if (value === null || value === undefined) {
        throw new Error(`${fieldName} is required.`);
    }

    let pattern = normalizePathText(String(value));
    if (!pattern) {
        throw new Error(`${fieldName} must not be empty.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(pattern)) {
        throw new Error(`${fieldName} must not contain control characters.`);
    }
    if (pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) {
        throw new Error(`${fieldName} must be a relative repository path or glob.`);
    }
    if (pattern.split('/').includes('..')) {
        throw new Error(`${fieldName} must not contain '..' path segments.`);
    }
    if (pattern === '.') {
        throw new Error(`${fieldName} must point to a file or directory pattern.`);
    }
    if (isRepositoryWideWildcardPattern(pattern) || !hasLiteralPathCharacter(pattern)) {
        throw new Error(`${fieldName} must not be a repository-wide wildcard.`);
    }

    if (pattern.endsWith('/')) {
        pattern = `${pattern}**`;
    }
    return pattern;
}

export function normalizeOrdinaryDocPathPatterns(
    value: unknown,
    fieldName = `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
    options: NormalizeOrdinaryDocPathsOptions = {}
): string[] {
    const items = Array.isArray(value) ? value : (options.allowScalar ? [value] : null);
    if (!items) {
        throw new Error(`${fieldName} must be an array.`);
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const pattern = normalizeOrdinaryDocPathPattern(item, fieldName);
        const dedupeKey = pattern.toLowerCase();
        if (!seen.has(dedupeKey)) {
            normalized.push(pattern);
            seen.add(dedupeKey);
        }
    }
    return normalized;
}

export function parseOrdinaryDocPathList(value: unknown, fieldName = ORDINARY_DOC_PATHS_CONFIG_KEY): string[] {
    if (Array.isArray(value)) {
        return normalizeOrdinaryDocPathPatterns(value, fieldName);
    }

    return normalizeOrdinaryDocPathPatterns(
        String(value || '')
            .split(/[,;\n\r]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        fieldName
    );
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function ordinaryDocPatternToRegex(pattern: string): RegExp {
    let source = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (char === '*') {
            if (pattern[index + 1] === '*') {
                source += '.*';
                index += 1;
            } else {
                source += '[^/]*';
            }
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += escapeRegex(char);
        }
    }
    source += '$';
    return new RegExp(source, 'i');
}

function cacheMatcherList(cacheKey: string, matchers: readonly OrdinaryDocPathMatcher[]): readonly OrdinaryDocPathMatcher[] {
    if (matcherCacheByKey.size >= MATCHER_CACHE_MAX_ENTRIES && !matcherCacheByKey.has(cacheKey)) {
        matcherCacheByKey.clear();
    }
    matcherCacheByKey.set(cacheKey, matchers);
    return matchers;
}

export function compileOrdinaryDocPathMatchers(patterns: readonly string[]): readonly OrdinaryDocPathMatcher[] {
    const normalizedPatterns = normalizeOrdinaryDocPathPatterns(patterns, ORDINARY_DOC_PATHS_CONFIG_KEY);
    const cacheKey = normalizedPatterns.join('\u0000');
    const cachedByKey = matcherCacheByKey.get(cacheKey);
    if (cachedByKey) {
        return cachedByKey;
    }

    const matchers = Object.freeze(normalizedPatterns.map((pattern) => Object.freeze({
        pattern,
        regex: ordinaryDocPatternToRegex(pattern)
    })));
    return cacheMatcherList(cacheKey, matchers);
}

export function matchOrdinaryDocPathMatcher(pathValue: string, matchers: readonly OrdinaryDocPathMatcher[]): string | null {
    const normalizedPath = normalizePathText(String(pathValue || ''));
    if (!normalizedPath) {
        return null;
    }
    for (const matcher of matchers) {
        if (matcher.regex.test(normalizedPath)) {
            return matcher.pattern;
        }
    }
    return null;
}

export function matchOrdinaryDocPathPattern(
    pathValue: string,
    patterns: readonly string[],
    matchers?: readonly OrdinaryDocPathMatcher[]
): string | null {
    const normalizedPath = normalizePathText(String(pathValue || ''));
    if (!normalizedPath) {
        return null;
    }

    return matchOrdinaryDocPathMatcher(normalizedPath, matchers || compileOrdinaryDocPathMatchers(patterns));
}

export function collectOrdinaryDocPathMatches(
    paths: readonly string[],
    patterns: readonly string[],
    matchers?: readonly OrdinaryDocPathMatcher[]
): OrdinaryDocPathMatch[] {
    const matches: OrdinaryDocPathMatch[] = [];
    const compiledMatchers = matchers || compileOrdinaryDocPathMatchers(patterns);
    for (const pathValue of paths) {
        const normalizedPath = normalizePathText(String(pathValue || ''));
        const matchedPattern = normalizedPath ? matchOrdinaryDocPathMatcher(normalizedPath, compiledMatchers) : null;
        if (matchedPattern) {
            matches.push({
                path: normalizedPath,
                pattern: matchedPattern
            });
        }
    }
    return matches;
}
