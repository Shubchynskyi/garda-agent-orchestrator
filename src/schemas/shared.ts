import { BOOLEAN_FALSE_VALUES, BOOLEAN_TRUE_VALUES } from '../core/constants';

export function ensurePlainObject(value: unknown, subject: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${subject} must be a JSON object.`);
    }

    return value as Record<string, unknown>;
}

export function normalizeNonEmptyString(value: unknown, fieldName: string): string {
    if (value === null || value === undefined) {
        throw new Error(`${fieldName} is required.`);
    }

    const normalized = String(value).trim();
    if (!normalized) {
        throw new Error(`${fieldName} must not be empty.`);
    }

    return normalized;
}

export function normalizeOptionalString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }

    return String(value).trim();
}

export function normalizeEnum(value: unknown, allowedValues: readonly string[], fieldName: string): string {
    const normalized = normalizeNonEmptyString(value, fieldName);
    const match = allowedValues.find((candidate) => candidate.toLowerCase() === normalized.toLowerCase());

    if (!match) {
        throw new Error(`${fieldName} must be one of: ${allowedValues.join(', ')}.`);
    }

    return match;
}

export function normalizeBooleanLike(value: unknown, fieldName: string): boolean {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value === 1)) {
        return value === 1;
    }

    const normalized = normalizeNonEmptyString(value, fieldName).toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(normalized)) {
        return true;
    }

    if (BOOLEAN_FALSE_VALUES.includes(normalized)) {
        return false;
    }

    throw new Error(`${fieldName} must be boolean-like.`);
}

interface IntegerOptions {
    minimum?: number;
    maximum?: number;
}

export function normalizeInteger(value: unknown, fieldName: string, options: IntegerOptions = {}): number {
    let normalized;

    if (typeof value === 'number' && Number.isInteger(value)) {
        normalized = value;
    } else {
        const text = normalizeNonEmptyString(value, fieldName);
        if (!/^-?\d+$/.test(text)) {
            throw new Error(`${fieldName} must be an integer.`);
        }

        normalized = Number.parseInt(text, 10);
    }

    if (options.minimum !== undefined && normalized < options.minimum) {
        throw new Error(`${fieldName} must be >= ${options.minimum}.`);
    }

    if (options.maximum !== undefined && normalized > options.maximum) {
        throw new Error(`${fieldName} must be <= ${options.maximum}.`);
    }

    return normalized;
}

interface StringArrayOptions {
    allowScalar?: boolean;
    unique?: boolean;
}

export function normalizeStringArray(value: unknown, fieldName: string, options: StringArrayOptions = {}): string[] {
    const allowScalar = options.allowScalar === true;
    const unique = options.unique !== false;
    const items = Array.isArray(value) ? value : (allowScalar ? [value] : null);

    if (!items) {
        throw new Error(`${fieldName} must be an array.`);
    }

    const normalized: string[] = [];
    for (const item of items) {
        const text = normalizeNonEmptyString(item, fieldName);
        if (!unique || !normalized.includes(text)) {
            normalized.push(text);
        }
    }

    return normalized;
}

export function cloneUnknownProperties(input: Record<string, unknown>, knownKeys: Set<string>): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!knownKeys.has(key)) {
            extras[key] = value;
        }
    }

    return extras;
}

