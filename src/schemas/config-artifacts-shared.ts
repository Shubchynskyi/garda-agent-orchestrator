import { normalizeInteger } from './shared';

export interface IntegerArrayOptions {
    allowScalar?: boolean;
    minimum?: number;
    maximum?: number;
}

export function normalizeIntegerArray(value: unknown, fieldName: string, options: IntegerArrayOptions = {}): number[] {
    const allowScalar = options.allowScalar === true;
    const items = Array.isArray(value) ? value : (allowScalar ? [value] : null);

    if (!items) {
        throw new Error(`${fieldName} must be an array.`);
    }

    const normalized: number[] = [];
    for (const item of items) {
        const integerValue = normalizeInteger(item, fieldName, options);
        if (!normalized.includes(integerValue)) {
            normalized.push(integerValue);
        }
    }

    return normalized.sort((left, right) => left - right);
}


export function assertNoCaseMismatchedKnownKeys(
    raw: Record<string, unknown>,
    knownKeys: readonly string[],
    fieldName: string
): void {
    const allowedKeySet = new Set(knownKeys);
    for (const key of Object.keys(raw)) {
        const caseInsensitiveMatch = knownKeys.find((candidate) => candidate.toLowerCase() === key.toLowerCase());
        if (caseInsensitiveMatch && !allowedKeySet.has(key)) {
            throw new Error(`${fieldName}.${key} must use the exact key '${caseInsensitiveMatch}'.`);
        }
    }
}

export function assertNoUnknownKeys(
    raw: Record<string, unknown>,
    knownKeys: readonly string[],
    fieldName: string
): void {
    const allowedKeySet = new Set(knownKeys);
    for (const key of Object.keys(raw)) {
        if (!allowedKeySet.has(key)) {
            throw new Error(`${fieldName}.${key} is not allowed.`);
        }
    }
}

export function computeEditDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const distances = Array.from({ length: rows }, (_, rowIndex) => (
        Array.from({ length: cols }, (_, colIndex) => (rowIndex === 0 ? colIndex : (colIndex === 0 ? rowIndex : 0)))
    ));

    for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
        for (let colIndex = 1; colIndex < cols; colIndex += 1) {
            const substitutionCost = left[rowIndex - 1] === right[colIndex - 1] ? 0 : 1;
            distances[rowIndex][colIndex] = Math.min(
                distances[rowIndex - 1][colIndex] + 1,
                distances[rowIndex][colIndex - 1] + 1,
                distances[rowIndex - 1][colIndex - 1] + substitutionCost
            );
        }
    }

    return distances[left.length][right.length];
}

export function findLikelyKnownKeyTypo(key: string, knownKeys: readonly string[]): string | null {
    const normalizedKey = key.toLowerCase();
    let bestCandidate: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of knownKeys) {
        const normalizedCandidate = candidate.toLowerCase();
        const maxDistance = normalizedCandidate.length >= 12 ? 2 : 1;
        const distance = computeEditDistance(normalizedKey, normalizedCandidate);
        if (distance <= maxDistance && distance < bestDistance) {
            bestCandidate = candidate;
            bestDistance = distance;
        }
    }

    return bestCandidate;
}

export function assertNoLikelyTypoKeys(
    raw: Record<string, unknown>,
    knownKeys: readonly string[],
    fieldName: string
): void {
    const allowedKeySet = new Set(knownKeys);
    for (const key of Object.keys(raw)) {
        if (allowedKeySet.has(key)) {
            continue;
        }
        const likelyMatch = findLikelyKnownKeyTypo(key, knownKeys);
        if (likelyMatch) {
            throw new Error(`${fieldName}.${key} is not allowed; did you mean '${likelyMatch}'?`);
        }
    }
}

