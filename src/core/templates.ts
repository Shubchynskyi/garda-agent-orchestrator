function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listTemplateTokens(text: string): string[] {
    const tokens = new Set<string>();
    const pattern = /\{\{([A-Z0-9_]+)\}\}/g;
    const source = String(text);
    let match = pattern.exec(source);

    while (match) {
        tokens.add(match[1]);
        match = pattern.exec(source);
    }

    return [...tokens];
}

export function replaceTemplateTokens(text: string, replacements: Record<string, string>): string {
    let result = String(text);

    for (const [key, value] of Object.entries(replacements)) {
        const pattern = new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, 'g');
        result = result.replace(pattern, String(value));
    }

    return result;
}

