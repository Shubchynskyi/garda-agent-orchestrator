export function toObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
