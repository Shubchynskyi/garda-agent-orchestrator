export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRequiredReviewRecord(requiredReviews: unknown): Record<string, boolean> | null {
    if (!isRecord(requiredReviews)) {
        return null;
    }

    const normalizedEntries = Object.entries(requiredReviews)
        .filter(([, required]) => typeof required === 'boolean')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(function ([reviewType, required]) {
            return [reviewType, required] as const;
        });

    if (normalizedEntries.length === 0) {
        return null;
    }

    return Object.fromEntries(normalizedEntries) as Record<string, boolean>;
}

export function stringifyNormalizedRequiredReviews(requiredReviews: unknown): string {
    return JSON.stringify(normalizeRequiredReviewRecord(requiredReviews) || {});
}
