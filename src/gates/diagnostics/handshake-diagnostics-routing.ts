export function normalizeRoutePath(value: unknown): string | null {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return null;
    }
    return text.replace(/^\.\//, '');
}

export function isAttestedReviewerSubagentExecutionSource(source: string | null): boolean {
    return source === 'provider_bridge'
        || source === 'provider_entrypoint'
        || source === 'explicit_provider'
        || source === 'task_mode';
}
