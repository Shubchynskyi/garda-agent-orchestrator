import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureTrailingLineEnding, normalizeLineEndings } from './line-endings';

export interface WriteTextFileOptions {
    newline?: string;
    trailingNewline?: boolean;
}

export function ensureDirectory(directoryPath: string): string {
    fs.mkdirSync(directoryPath, { recursive: true });
    return directoryPath;
}

export function pathExists(targetPath: string): boolean {
    return fs.existsSync(targetPath);
}

export function readTextFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

export function writeTextFile(filePath: string, content: string, options: WriteTextFileOptions = {}): string {
    const newline = options.newline || '\n';
    const trailingNewline = options.trailingNewline === true;
    const directoryPath = path.dirname(filePath);
    ensureDirectory(directoryPath);

    let text = normalizeLineEndings(content, newline);
    if (trailingNewline) {
        text = ensureTrailingLineEnding(text, newline);
    }

    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
}

