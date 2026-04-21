import { toStringArray } from '../text-utils';
import { getFilterPatterns, resolveFilterInt, selectHeadLines, selectTailLines } from './utils';

/**
 * Apply a single output filter operation, matching Python apply_output_filter_operation.
 */
export function applyOutputFilterOperation(
    lines: unknown,
    operation: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined = null
): string[] {
    if (!operation || typeof operation !== 'object') {
        throw new Error('Filter operation must be an object.');
    }

    const operationType = String(operation.type || '').trim().toLowerCase();
    if (!operationType) {
        throw new Error("Filter operation requires non-empty `type`.");
    }

    const currentLines = toStringArray(lines);

    if (operationType === 'strip_ansi') {
        const ansiPattern = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
        return currentLines.map(line => line.replace(ansiPattern, ''));
    }
    if (operationType === 'regex_replace') {
        const pattern = String(operation.pattern || '').trim();
        if (!pattern) {
            throw new Error("regex_replace requires non-empty `pattern`.");
        }
        const compiled = new RegExp(pattern, 'g');
        const replacement = String(operation.replacement || '');
        return currentLines.map(line => line.replace(compiled, replacement));
    }
    if (operationType === 'drop_lines_matching') {
        const patterns = getFilterPatterns(operation);
        const compiledPatterns = patterns.map(p => new RegExp(p));
        return currentLines.filter(line => !compiledPatterns.some(p => p.test(line)));
    }
    if (operationType === 'keep_lines_matching') {
        const patterns = getFilterPatterns(operation);
        const compiledPatterns = patterns.map(p => new RegExp(p));
        return currentLines.filter(line => compiledPatterns.some(p => p.test(line)));
    }
    if (operationType === 'truncate_line_length') {
        const maxChars = resolveFilterInt(operation.max_chars, context, 'truncate_line_length.max_chars', 1);
        const suffix = String(operation.suffix != null ? operation.suffix : '...');
        const result: string[] = [];
        for (const line of currentLines) {
            if (line.length <= maxChars) {
                result.push(line);
            } else if (suffix.length >= maxChars) {
                result.push(suffix.substring(0, maxChars));
            } else {
                result.push(line.substring(0, maxChars - suffix.length) + suffix);
            }
        }
        return result;
    }
    if (operationType === 'head') {
        const count = resolveFilterInt(operation.count, context, 'head.count', 1);
        return selectHeadLines(currentLines, count);
    }
    if (operationType === 'tail') {
        const count = resolveFilterInt(operation.count, context, 'tail.count', 1);
        return selectTailLines(currentLines, count);
    }
    if (operationType === 'max_total_lines') {
        const maxLines = resolveFilterInt(operation.max_lines, context, 'max_total_lines.max_lines', 0);
        const strategy = String(operation.strategy || 'tail').trim().toLowerCase() || 'tail';
        if (maxLines === 0) return [];
        if (strategy === 'head') return selectHeadLines(currentLines, maxLines);
        if (strategy === 'tail') return selectTailLines(currentLines, maxLines);
        throw new Error("max_total_lines.strategy must be 'head' or 'tail'.");
    }

    throw new Error(`Unsupported filter operation type '${operationType}'.`);
}
