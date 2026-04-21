import { CompileStrategyConfig, ParserResult } from './types';
import { addUniqueLines, resolveFilterInt, resolveFilterStr, selectHeadLines, selectTailLines } from './utils';
import { formatGroupedLines, groupMatchingLines } from './error-grouping';

// --- Compile failure strategy configs ---

const COMPILE_STRATEGY_CONFIGS = {
    maven: {
        display_name: 'maven',
        full_patterns: [
            String.raw`^\[ERROR\]`,
            'BUILD FAILURE',
            'COMPILATION ERROR',
            'Failed to execute goal',
            'There are test failures',
            String.raw`Tests run: .*Failures:`,
            'Re-run Maven'
        ],
        degraded_patterns: [String.raw`^\[ERROR\]`, String.raw`^\[WARNING\]`, 'BUILD FAILURE', 'error']
    },
    gradle: {
        display_name: 'gradle',
        full_patterns: [
            String.raw`^FAILURE: Build failed with an exception\.`,
            '^BUILD FAILED',
            'Execution failed for task',
            String.raw`^\* What went wrong:`,
            '^> .*',
            '^> Task .*FAILED'
        ],
        degraded_patterns: ['^FAILURE:', '^BUILD FAILED', 'FAILED', 'error']
    },
    node: {
        display_name: 'node-build',
        full_patterns: [
            '^npm ERR!',
            '^ERR!',
            'Command failed with exit code',
            'Failed to compile',
            'ERROR in',
            'Type error',
            'Module not found'
        ],
        degraded_patterns: ['^npm ERR!', 'warning', 'error', 'failed']
    },
    cargo: {
        display_name: 'cargo',
        full_patterns: [
            String.raw`^error(\[[A-Z0-9]+\])?:`,
            '^Caused by:',
            'could not compile',
            '^failures:',
            '^test result: FAILED'
        ],
        degraded_patterns: ['^warning:', '^error', 'FAILED']
    },
    dotnet: {
        display_name: 'dotnet',
        full_patterns: [
            String.raw`^Build FAILED\.`,
            String.raw`^\s*error [A-Z]{2,}\d+:`,
            String.raw`^\s*warning [A-Z]{2,}\d+:`,
            String.raw`^Failed!  - Failed:`,
            String.raw`^Test Run Failed\.`
        ],
        degraded_patterns: [String.raw`^\s*error `, String.raw`^\s*warning `, 'FAILED']
    },
    go: {
        display_name: 'go',
        full_patterns: [
            '^# ',
            '^--- FAIL:',
            String.raw`^FAIL(\s|$)`,
            '^panic:',
            'cannot use',
            'undefined:'
        ],
        degraded_patterns: ['^FAIL', '^panic:', 'error']
    }
};

export function getCompileFailureStrategyConfig(strategy: string): CompileStrategyConfig {
    const normalized = (strategy || '').trim().toLowerCase();
    if (normalized in COMPILE_STRATEGY_CONFIGS) {
        return COMPILE_STRATEGY_CONFIGS[normalized as keyof typeof COMPILE_STRATEGY_CONFIGS];
    }
    return {
        display_name: 'generic-compile',
        full_patterns: ['error', 'failed', 'exception', 'cannot ', 'undefined', 'not found'],
        degraded_patterns: ['warning', 'error', 'failed']
    };
}

function invokeCompileFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    let strategy = resolveFilterStr(parserConfig.strategy, context, 'parser.strategy', { allowEmpty: true });
    if (!strategy) {
        strategy = resolveFilterStr({ context_key: 'command_filter_strategy' }, context, 'parser.strategy_context', { allowEmpty: true });
    }
    if (!strategy) {
        strategy = 'generic';
    }

    const config = getCompileFailureStrategyConfig(strategy);
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);

    const fullGrouping = groupMatchingLines(lines, config.full_patterns, maxMatches);
    if (fullGrouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=${config.display_name} | ${fullGrouping.unique_groups} group(s), ${fullGrouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(fullGrouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'compile_failure_summary',
            parser_strategy: config.display_name,
            fallback_mode: 'none',
            grouping: fullGrouping
        };
    }

    const degradedGrouping = groupMatchingLines(lines, config.degraded_patterns, Math.max(maxMatches, 8));
    if (degradedGrouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: DEGRADED | strategy=${config.display_name} | ${degradedGrouping.unique_groups} group(s), ${degradedGrouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(degradedGrouping), { limit: Math.max(maxMatches, 8) + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'DEGRADED',
            parser_name: 'compile_failure_summary',
            parser_strategy: config.display_name,
            fallback_mode: 'none',
            grouping: degradedGrouping
        };
    }

    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'compile_failure_summary',
        parser_strategy: config.display_name,
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeTestFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);
    const patterns = [
        '^--- FAIL:',
        String.raw`^FAIL(\s|$)`,
        '^FAILED',
        '^failures?:',
        '^panic:',
        '^AssertionError',
        '^Error:',
        String.raw`[0-9]+\s+failed`,
        'Test Run Failed',
        '[✕×]'
    ];
    const grouping = groupMatchingLines(lines, patterns, maxMatches);
    if (grouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=test | ${grouping.unique_groups} group(s), ${grouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(grouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'test_failure_summary',
            parser_strategy: 'test',
            fallback_mode: 'none',
            grouping
        };
    }
    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'test_failure_summary',
        parser_strategy: 'test',
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeLintFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);
    const patterns = [
        String.raw`^\s*error`,
        String.raw`^\s*warning`,
        String.raw`:[0-9]+(:[0-9]+)?\s+(error|warning)`,
        String.raw`^Found\s+[0-9]+\s+errors?`,
        '[✖×]',
        'problems?'
    ];
    const grouping = groupMatchingLines(lines, patterns, maxMatches);
    if (grouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=lint | ${grouping.unique_groups} group(s), ${grouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(grouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'lint_failure_summary',
            parser_strategy: 'lint',
            fallback_mode: 'none',
            grouping
        };
    }
    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'lint_failure_summary',
        parser_strategy: 'lint',
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeReviewSummaryParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxLines = resolveFilterInt(parserConfig.max_lines, context, 'parser.max_lines', 1);
    const summaryLines = selectHeadLines(lines, maxLines);
    if (summaryLines.length === 0) {
        return {
            lines: [...lines],
            parser_mode: 'PASSTHROUGH',
            parser_name: 'review_gate_summary',
            parser_strategy: 'review',
            fallback_mode: 'parser_passthrough',
            grouping: null
        };
    }
    return {
        lines: summaryLines,
        parser_mode: 'FULL',
        parser_name: 'review_gate_summary',
        parser_strategy: 'review',
        fallback_mode: 'none',
        grouping: null
    };
}

export function applyOutputParser(
    lines: string[],
    parserConfig: Record<string, unknown> | null | undefined,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    if (parserConfig == null) {
        return {
            lines: [...lines],
            parser_mode: 'NONE',
            parser_name: null,
            parser_strategy: null,
            fallback_mode: 'none',
            grouping: null
        };
    }
    if (typeof parserConfig !== 'object') {
        throw new Error('Profile parser must be an object.');
    }

    const parserType = resolveFilterStr(parserConfig.type, context, 'parser.type');
    const normalized = parserType.trim().toLowerCase();
    if (normalized === 'compile_failure_summary') {
        return invokeCompileFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'test_failure_summary') {
        return invokeTestFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'lint_failure_summary') {
        return invokeLintFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'review_gate_summary') {
        return invokeReviewSummaryParser(lines, parserConfig, context);
    }
    throw new Error(`Unsupported profile parser type '${parserType}'.`);
}
