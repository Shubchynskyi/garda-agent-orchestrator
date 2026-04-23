export function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergeConfig(
    template: Record<string, unknown>,
    existing: Record<string, unknown> | null
): Record<string, unknown> {
    if (!isPlainObject(existing)) {
        return cloneJsonValue(template);
    }

    const result: Record<string, unknown> = {};

    for (const key of Object.keys(template)) {
        const existingKey = Object.keys(existing).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
        if (existingKey !== undefined && existing[existingKey] !== undefined) {
            if (isPlainObject(template[key]) && isPlainObject(existing[existingKey])) {
                result[key] = mergeConfig(
                    template[key] as Record<string, unknown>,
                    existing[existingKey] as Record<string, unknown>
                );
            } else {
                result[key] = cloneJsonValue(existing[existingKey]);
            }
        } else {
            result[key] = cloneJsonValue(template[key]);
        }
    }

    for (const key of Object.keys(existing)) {
        if (!Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
            result[key] = cloneJsonValue(existing[key]);
        }
    }

    return result;
}
