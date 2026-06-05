export function extractReviewVerdictToken(
    content: unknown,
    passVerdict: string | null,
    failVerdict: string | null = null,
    reviewType: string | null = null
): string | null {
    const tokenMatch = extractReviewVerdictTokenMatch(content, buildReviewVerdictTokenSet(
        reviewType,
        passVerdict,
        failVerdict
    ));
    return tokenMatch?.canonicalToken ?? null;
}

export interface ReviewVerdictTokenSet {
    canonicalPassToken: string | null;
    canonicalFailToken: string | null;
    passTokens: string[];
    failTokens: string[];
}

export interface ReviewVerdictTokenMatch {
    canonicalToken: string;
    matchedToken: string;
    outcome: 'pass' | 'fail';
}

function normalizeReviewVerdictToken(value: string | null | undefined): string | null {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized || null;
}

function dedupeReviewVerdictTokens(values: Array<string | null | undefined>): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = normalizeReviewVerdictToken(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function formatTypedReviewVerdictToken(reviewType: string | null | undefined, outcome: 'PASSED' | 'FAILED'): string | null {
    const reviewLabel = String(reviewType || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return reviewLabel ? `${reviewLabel} REVIEW ${outcome}` : null;
}

function getReviewVerdictPassAliases(reviewType: string | null | undefined): Array<string | null> {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (normalizedReviewType === 'code') {
        return ['CODE REVIEW PASSED', 'REVIEW PASSED'];
    }
    return [];
}

function getReviewVerdictFailAliases(reviewType: string | null | undefined): Array<string | null> {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (normalizedReviewType === 'code') {
        return ['CODE REVIEW FAILED', 'REVIEW FAILED'];
    }
    return [];
}

export function buildReviewVerdictTokenSet(
    reviewType: string | null | undefined,
    passVerdict: string | null,
    failVerdict: string | null = null
): ReviewVerdictTokenSet {
    const canonicalPassToken = normalizeReviewVerdictToken(passVerdict);
    const canonicalFailToken = normalizeReviewVerdictToken(failVerdict)
        || (canonicalPassToken ? canonicalPassToken.replace(/\bPASSED\b/g, 'FAILED') : null);

    return {
        canonicalPassToken,
        canonicalFailToken,
        passTokens: dedupeReviewVerdictTokens([
            canonicalPassToken,
            formatTypedReviewVerdictToken(reviewType, 'PASSED'),
            ...getReviewVerdictPassAliases(reviewType)
        ]),
        failTokens: dedupeReviewVerdictTokens([
            canonicalFailToken,
            formatTypedReviewVerdictToken(reviewType, 'FAILED'),
            ...getReviewVerdictFailAliases(reviewType)
        ])
    };
}

export function formatReviewVerdictTokenList(tokens: readonly string[]): string {
    return tokens.length > 0
        ? tokens.map((token) => `'${token}'`).join(', ')
        : '<none>';
}

export function formatAcceptedReviewVerdictTokens(tokens: ReviewVerdictTokenSet): string {
    return `Accepted PASS tokens: ${formatReviewVerdictTokenList(tokens.passTokens)}; ` +
        `accepted FAIL tokens: ${formatReviewVerdictTokenList(tokens.failTokens)}.`;
}

function normalizeReviewVerdictCandidateLine(line: string): string {
    let normalized = line.trim();
    normalized = normalized.replace(/^[-*+]\s+/, '');
    if (/^`.+`$/.test(normalized)) {
        normalized = normalized.slice(1, -1).trim();
    }
    return normalized;
}

function matchReviewVerdictCandidateLine(
    line: string,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    if (tokenSet.canonicalFailToken) {
        for (const failToken of tokenSet.failTokens) {
            if (line === failToken) {
                return {
                    canonicalToken: tokenSet.canonicalFailToken,
                    matchedToken: failToken,
                    outcome: 'fail'
                };
            }
        }
    }
    if (tokenSet.canonicalPassToken) {
        for (const passToken of tokenSet.passTokens) {
            if (line === passToken) {
                return {
                    canonicalToken: tokenSet.canonicalPassToken,
                    matchedToken: passToken,
                    outcome: 'pass'
                };
            }
        }
    }
    return null;
}

export function extractReviewVerdictSectionTokenMatch(
    content: unknown,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    const reviewText = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!reviewText.trim()) {
        return null;
    }

    const candidateLines = reviewText
        .split('\n')
        .map((line) => normalizeReviewVerdictCandidateLine(line))
        .filter((line) => line.length > 0);
    const verdictHeadingIndex = candidateLines.findIndex((line) => /^##+\s+verdict$/i.test(line));
    if (verdictHeadingIndex < 0) {
        return null;
    }

    for (let index = verdictHeadingIndex + 1; index < candidateLines.length; index += 1) {
        const line = candidateLines[index];
        const match = matchReviewVerdictCandidateLine(line, tokenSet);
        if (match) {
            return match;
        }
        if (/^##+\s+/.test(line)) {
            break;
        }
    }
    return null;
}

export function extractReviewVerdictTokenMatch(
    content: unknown,
    tokenSet: ReviewVerdictTokenSet
): ReviewVerdictTokenMatch | null {
    const reviewText = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!reviewText.trim()) {
        return null;
    }

    const candidateLines = reviewText
        .split('\n')
        .map((line) => normalizeReviewVerdictCandidateLine(line))
        .filter((line) => line.length > 0);
    const verdictHeadingIndex = candidateLines.findIndex((line) => /^##+\s+verdict$/i.test(line));
    if (verdictHeadingIndex >= 0) {
        for (let index = verdictHeadingIndex + 1; index < candidateLines.length; index += 1) {
            const line = candidateLines[index];
            const match = matchReviewVerdictCandidateLine(line, tokenSet);
            if (match) {
                return match;
            }
            if (/^##+\s+/.test(line)) {
                break;
            }
        }
    }

    for (const line of candidateLines) {
        const match = matchReviewVerdictCandidateLine(line, tokenSet);
        if (match) {
            return match;
        }
    }
    return null;
}
