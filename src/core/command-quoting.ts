export function quoteCommandValue(value: string): string {
    const text = String(value);
    if (/["$`]/.test(text)) {
        if (process.platform === 'win32') {
            return `'${text.replace(/'/g, "''")}'`;
        }
        return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return `"${text.replace(/\\/g, '\\\\')}"`;
}
