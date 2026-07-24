import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Build a lowercase SHA-256 digest for a string-compatible value.
 */
export function stringSha256(value: unknown): string | null {
    if (value == null) return null;
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').toLowerCase();
}

/**
 * Build a lowercase SHA-256 digest for a regular file.
 */
export function fileSha256(filePath: string): string | null {
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
    } catch {
        return null;
    }
}
