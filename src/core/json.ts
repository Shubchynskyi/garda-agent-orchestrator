import * as path from 'node:path';
import { ensureDirectory } from './fs';
import { ensureTrailingLineEnding } from './line-endings';
import * as fs from 'node:fs';

export interface FormatJsonOptions {
    indent?: number;
    newline?: string;
}

export function parseJsonText(text: string, sourceLabel: string = 'JSON input'): unknown {
    try {
        return JSON.parse(text);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in ${sourceLabel}: ${message}`);
    }
}

export function readJsonFile(filePath: string): unknown {
    return parseJsonText(fs.readFileSync(filePath, 'utf8'), filePath);
}

export function formatJson(value: unknown, options: FormatJsonOptions = {}): string {
    const indent = options.indent ?? 2;
    const newline = options.newline || '\n';
    return ensureTrailingLineEnding(JSON.stringify(value, null, indent), newline);
}

export function writeJsonFile(filePath: string, value: unknown, options: FormatJsonOptions = {}): string {
    ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, formatJson(value, options), 'utf8');
    return filePath;
}

