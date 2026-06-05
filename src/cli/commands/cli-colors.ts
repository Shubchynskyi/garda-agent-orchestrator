import type { HighlightedPairOptions } from './cli-types';

export function applyNoColorFlag(noColor: boolean): void {
    if (noColor) {
        process.env.NO_COLOR = '1';
    }
}

export function supportsColor(): boolean {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR !== undefined) return true;
    return Boolean(process.stdout && process.stdout.isTTY);
}

export function colorize(text: string, code: string): string {
    return supportsColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function bold(text: string): string { return colorize(text, '1'); }
export function green(text: string): string { return colorize(text, '32'); }
export function cyan(text: string): string { return colorize(text, '36'); }
export function yellow(text: string): string { return colorize(text, '33'); }
export function red(text: string): string { return colorize(text, '31'); }
export function dim(text: string): string { return colorize(text, '2'); }

export function padRight(text: string, width: number): string {
    return String(text).padEnd(width, ' ');
}

export function printHighlightedPair(label: string, value: string, options?: HighlightedPairOptions): void {
    const labelColor = (options && options.labelColor) || yellow;
    const valueColor = (options && options.valueColor) || green;
    const indent = (options && options.indent) || '';
    console.log(`${indent}${labelColor(label)} ${valueColor(value)}`);
}
