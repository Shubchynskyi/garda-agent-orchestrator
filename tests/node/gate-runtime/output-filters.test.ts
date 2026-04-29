import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    applyOutputFilterOperation,
    applyOutputFilterProfile,
    applyPassthroughCeiling,
    resolveFilterInt,
    resolveFilterStr,
    selectHeadLines,
    selectTailLines,
    selectMatchingLines,
    getCompileFailureStrategyConfig,
    resolveBudgetTier,
    normalizeErrorSignature,
    groupMatchingLines,
    formatGroupedLines
} from '../../../src/gate-runtime/output-filters';


test('resolveFilterInt resolves plain integer', () => {
    assert.equal(resolveFilterInt(42, null, 'test'), 42);
});

test('resolveFilterInt resolves integer string', () => {
    assert.equal(resolveFilterInt('42', null, 'test'), 42);
});

test('resolveFilterInt resolves context_key', () => {
    assert.equal(resolveFilterInt({ context_key: 'my_val' }, { my_val: 100 }, 'test'), 100);
});

test('resolveFilterInt throws for missing context key', () => {
    assert.throws(
        () => resolveFilterInt({ context_key: 'missing' }, {}, 'test'),
        /references missing context key/
    );
});

test('resolveFilterInt throws for boolean', () => {
    assert.throws(() => resolveFilterInt(true, null, 'test'), /must resolve to integer/);
});

test('resolveFilterInt enforces minimum', () => {
    assert.throws(() => resolveFilterInt(-1, null, 'test', 0), /must resolve to integer >= 0/);
});


test('resolveFilterStr resolves plain string', () => {
    assert.equal(resolveFilterStr('hello', null, 'test'), 'hello');
});

test('resolveFilterStr resolves context_key', () => {
    assert.equal(resolveFilterStr({ context_key: 'name' }, { name: 'world' }, 'test'), 'world');
});

test('resolveFilterStr throws for null value', () => {
    assert.throws(() => resolveFilterStr(null as unknown, null, 'test'), /non-empty string/);
});

test('resolveFilterStr allows empty when option set', () => {
    assert.equal(resolveFilterStr(null as unknown, null, 'test', { allowEmpty: true }), '');
});


test('selectHeadLines returns first N lines', () => {
    assert.deepEqual(selectHeadLines(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
});

test('selectTailLines returns last N lines', () => {
    assert.deepEqual(selectTailLines(['a', 'b', 'c', 'd'], 2), ['c', 'd']);
});

test('selectHeadLines returns empty for count 0', () => {
    assert.deepEqual(selectHeadLines(['a', 'b'], 0), []);
});

test('selectTailLines returns empty for count 0', () => {
    assert.deepEqual(selectTailLines(['a', 'b'], 0), []);
});


test('selectMatchingLines filters by regex', () => {
    const lines = ['error: foo', 'info: bar', 'error: baz'];
    assert.deepEqual(selectMatchingLines(lines, ['^error']), ['error: foo', 'error: baz']);
});

test('selectMatchingLines respects limit', () => {
    const lines = ['error: 1', 'error: 2', 'error: 3'];
    assert.deepEqual(selectMatchingLines(lines, ['^error'], { limit: 2 }), ['error: 1', 'error: 2']);
});


test('strip_ansi removes ANSI escape sequences', () => {
    const lines = ['\x1B[31merror\x1B[0m: something', 'clean line'];
    const result = applyOutputFilterOperation(lines, { type: 'strip_ansi' });
    assert.deepEqual(result, ['error: something', 'clean line']);
});

test('regex_replace replaces patterns', () => {
    const lines = ['timestamp: 2024-01-15T10:30:00Z message'];
    const result = applyOutputFilterOperation(lines, {
        type: 'regex_replace',
        pattern: '\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z',
        replacement: '<TIMESTAMP>'
    });
    assert.deepEqual(result, ['timestamp: <TIMESTAMP> message']);
});

test('drop_lines_matching drops matched lines', () => {
    const lines = ['keep this', 'DEBUG: drop this', 'keep this too'];
    const result = applyOutputFilterOperation(lines, {
        type: 'drop_lines_matching',
        pattern: '^DEBUG:'
    });
    assert.deepEqual(result, ['keep this', 'keep this too']);
});

test('keep_lines_matching keeps only matched lines', () => {
    const lines = ['error: important', 'info: noise', 'error: also important'];
    const result = applyOutputFilterOperation(lines, {
        type: 'keep_lines_matching',
        pattern: '^error:'
    });
    assert.deepEqual(result, ['error: important', 'error: also important']);
});

test('truncate_line_length truncates long lines', () => {
    const lines = ['short', 'this is a very long line that should be truncated'];
    const result = applyOutputFilterOperation(lines, {
        type: 'truncate_line_length',
        max_chars: 10,
        suffix: '...'
    });
    assert.deepEqual(result, ['short', 'this is...']);
});

test('head returns first N lines', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const result = applyOutputFilterOperation(lines, { type: 'head', count: 2 });
    assert.deepEqual(result, ['a', 'b']);
});

test('tail returns last N lines', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const result = applyOutputFilterOperation(lines, { type: 'tail', count: 2 });
    assert.deepEqual(result, ['c', 'd']);
});

test('max_total_lines with tail strategy', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const result = applyOutputFilterOperation(lines, {
        type: 'max_total_lines',
        max_lines: 3,
        strategy: 'tail'
    });
    assert.deepEqual(result, ['c', 'd', 'e']);
});

test('max_total_lines with head strategy', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const result = applyOutputFilterOperation(lines, {
        type: 'max_total_lines',
        max_lines: 3,
        strategy: 'head'
    });
    assert.deepEqual(result, ['a', 'b', 'c']);
});

test('max_total_lines zero returns empty', () => {
    const result = applyOutputFilterOperation(['a', 'b'], {
        type: 'max_total_lines',
        max_lines: 0
    });
    assert.deepEqual(result, []);
});

test('unsupported operation type throws', () => {
    assert.throws(
        () => applyOutputFilterOperation(['a'], { type: 'nonexistent' }),
        /Unsupported filter operation type/
    );
});

test('missing type throws', () => {
    assert.throws(
        () => applyOutputFilterOperation(['a'], {}),
        /requires non-empty `type`/
    );
});


test('applyPassthroughCeiling passes through when under limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const result = applyPassthroughCeiling(lines, null, 'test');
    assert.equal(result.length, 10);
});

test('applyPassthroughCeiling truncates when over limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result = applyPassthroughCeiling(lines, null, 'test');
    assert.equal(result.length, 61); // 60 + 1 header
    assert.match(result[0], /\[passthrough-ceiling\]/);
});

test('applyPassthroughCeiling respects config override', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const config = { passthrough_ceiling: { max_lines: 10, strategy: 'head' } };
    const result = applyPassthroughCeiling(lines, config, 'test');
    assert.equal(result.length, 11); // 10 + 1 header
    assert.match(result[0], /strategy=head/);
});


test('getCompileFailureStrategyConfig returns known strategies', () => {
    for (const name of ['maven', 'gradle', 'node', 'cargo', 'dotnet', 'go']) {
        const config = getCompileFailureStrategyConfig(name);
        assert.ok(config.display_name);
        assert.ok(config.full_patterns.length > 0);
        assert.ok(config.degraded_patterns.length > 0);
    }
});

test('getCompileFailureStrategyConfig returns generic for unknown', () => {
    const config = getCompileFailureStrategyConfig('unknown');
    assert.equal(config.display_name, 'generic-compile');
});


test('applyOutputFilterProfile returns passthrough for empty profile name', () => {
    const result = applyOutputFilterProfile(['a', 'b'], null as unknown as string, '');
    assert.equal(result.filter_mode, 'passthrough');
    assert.deepEqual(result.lines, ['a', 'b']);
});

test('applyOutputFilterProfile returns fallback for missing config', () => {
    const result = applyOutputFilterProfile(['a', 'b'], '/nonexistent.json', 'test');
    assert.equal(result.fallback_mode, 'missing_config_passthrough');
});

test('applyOutputFilterProfile applies profile from config file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-filters-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            profiles: {
                test_profile: {
                    description: 'Test profile',
                    operations: [
                        { type: 'drop_lines_matching', pattern: '^DEBUG:' }
                    ]
                }
            }
        }), 'utf8');

        const lines = ['DEBUG: noise', 'error: important', 'DEBUG: more noise'];
        const result = applyOutputFilterProfile(lines, configPath, 'test_profile');
        assert.equal(result.filter_mode, 'profile:test_profile');
        assert.deepEqual(result.lines, ['error: important']);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile returns fallback for missing profile', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-filters-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            profiles: {}
        }), 'utf8');

        const result = applyOutputFilterProfile(['a'], configPath, 'nonexistent');
        assert.equal(result.fallback_mode, 'missing_profile_passthrough');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('resolveBudgetTier returns no match when budgetTokens is null', () => {
    const result = resolveBudgetTier(null, null);
    assert.equal(result.matched, false);
    assert.equal(result.tier_label, 'none');
});

test('resolveBudgetTier returns no match when budgetTokens is negative', () => {
    const result = resolveBudgetTier(null, -1);
    assert.equal(result.matched, false);
});

test('resolveBudgetTier matches tight tier with default tiers', () => {
    const result = resolveBudgetTier(null, 300);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'tight');
    assert.ok(result.overrides_applied.length > 0);
});

test('resolveBudgetTier matches moderate tier with default tiers', () => {
    const result = resolveBudgetTier(null, 800);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'moderate');
});

test('resolveBudgetTier matches generous tier with default tiers', () => {
    const result = resolveBudgetTier(null, 2000);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'generous');
});

test('resolveBudgetTier matches exact boundary of tight tier', () => {
    const result = resolveBudgetTier(null, 500);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'tight');
});

test('resolveBudgetTier uses custom tiers from config', () => {
    const config = {
        budget_profiles: {
            enabled: true,
            tiers: [
                { label: 'micro', max_tokens: 100, passthrough_ceiling_max_lines: 10, fail_tail_lines: 5, max_matches: 3, max_parser_lines: 4, truncate_line_max_chars: 100 },
                { label: 'default', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
            ]
        }
    };
    const result = resolveBudgetTier(config, 50);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'micro');
});

test('resolveBudgetTier returns no match when budget_profiles disabled', () => {
    const config = {
        budget_profiles: {
            enabled: false,
            tiers: [
                { label: 'tight', max_tokens: 500, passthrough_ceiling_max_lines: 20, fail_tail_lines: 15, max_matches: 5, max_parser_lines: 6, truncate_line_max_chars: 160 }
            ]
        }
    };
    const result = resolveBudgetTier(config, 300);
    assert.equal(result.matched, false);
});

test('resolveBudgetTier falls through to catch-all tier', () => {
    const config = {
        budget_profiles: {
            enabled: true,
            tiers: [
                { label: 'small', max_tokens: 200, passthrough_ceiling_max_lines: 15, fail_tail_lines: 10, max_matches: 4, max_parser_lines: 5, truncate_line_max_chars: 120 },
                { label: 'catchall', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
            ]
        }
    };
    const result = resolveBudgetTier(config, 99999);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'catchall');
});


test('applyOutputFilterProfile applies budget tier overrides (tight)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-budget-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            passthrough_ceiling: { max_lines: 60, strategy: 'tail' },
            budget_profiles: {
                enabled: true,
                tiers: [
                    { label: 'tight', max_tokens: 500, passthrough_ceiling_max_lines: 20, fail_tail_lines: 15, max_matches: 5, max_parser_lines: 6, truncate_line_max_chars: 160 },
                    { label: 'generous', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
                ]
            },
            profiles: {
                test_profile: {
                    description: 'Test profile',
                    operations: [
                        { type: 'truncate_line_length', max_chars: 240 }
                    ]
                }
            }
        }), 'utf8');

        const longLine = 'x'.repeat(200);
        const result = applyOutputFilterProfile([longLine], configPath, 'test_profile', { budgetTokens: 300 });
        assert.equal(result.budget_tier, 'tight');
        // Tight tier truncates to 160 chars; line is 200, truncated to 157 + '...' = 160
        assert.equal(result.lines[0].length, 160, `expected exactly 160 chars, got ${result.lines[0].length}`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile has null budget_tier without budget', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-budget-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                test_profile: {
                    description: 'Test profile',
                    operations: [{ type: 'strip_ansi' }]
                }
            }
        }), 'utf8');

        const result = applyOutputFilterProfile(['hello'], configPath, 'test_profile');
        assert.equal(result.budget_tier, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile budget overrides fail_tail_lines in context', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-budget-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            passthrough_ceiling: { max_lines: 60, strategy: 'tail' },
            budget_profiles: {
                enabled: true,
                tiers: [
                    { label: 'tight', max_tokens: 500, passthrough_ceiling_max_lines: 20, fail_tail_lines: 3, max_matches: 5, max_parser_lines: 6, truncate_line_max_chars: 160 },
                    { label: 'generous', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
                ]
            },
            profiles: {
                test_compile: {
                    description: 'Test compile failure',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'compile_failure_summary',
                        strategy: 'node',
                        max_matches: 12,
                        tail_count: { context_key: 'fail_tail_lines' }
                    }
                }
            }
        }), 'utf8');

        const lines = [
            'info: all good',
            'npm ERR! missing script',
            'tail 1',
            'tail 2',
            'tail 3',
            'tail 4',
            'tail 5',
            'tail 6',
            'tail 7',
            'tail 8',
            'tail 9',
            'tail 10'
        ];
        const result = applyOutputFilterProfile(lines, configPath, 'test_compile', {
            budgetTokens: 300,
            context: { fail_tail_lines: 50 }
        });
        assert.equal(result.budget_tier, 'tight');
        // Tight tier overrides fail_tail_lines to 3 and context_key resolves to 3
        // Expect: header + 1 match (npm ERR!) + 3 tail lines = 5 unique lines max
        assert.ok(result.lines.length <= 5, `expected at most 5 lines with tight budget, got ${result.lines.length}`);
        assert.ok(result.lines.some(l => l.includes('CompactSummary')), 'expected compact summary header');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resolveBudgetTier matches zero budgetTokens to tight tier', () => {
    const result = resolveBudgetTier(null, 0);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'tight');
});

test('resolveBudgetTier at moderate boundary 1500 matches moderate', () => {
    const result = resolveBudgetTier(null, 1500);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'moderate');
});

test('resolveBudgetTier at moderate boundary 1501 matches generous', () => {
    const result = resolveBudgetTier(null, 1501);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'generous');
});

test('resolveBudgetTier coerces non-integer max_tokens to catch-all null', () => {
    const config = {
        budget_profiles: {
            enabled: true,
            tiers: [
                { label: 'bad', max_tokens: 'not-a-number', passthrough_ceiling_max_lines: 10 }
            ]
        }
    };
    // 'not-a-number' is coerced to null (catch-all), so any budget matches
    const result = resolveBudgetTier(config, 99999);
    assert.equal(result.matched, true);
    assert.equal(result.tier_label, 'bad');
});

test('applyOutputFilterProfile backward compat: no budgetTokens matches existing behavior', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-budget-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            passthrough_ceiling: { max_lines: 60, strategy: 'tail' },
            budget_profiles: {
                enabled: true,
                tiers: [
                    { label: 'tight', max_tokens: 500, passthrough_ceiling_max_lines: 10, fail_tail_lines: 5, max_matches: 2, max_parser_lines: 3, truncate_line_max_chars: 80 },
                    { label: 'generous', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
                ]
            },
            profiles: {
                test_profile: {
                    description: 'Test profile',
                    operations: [{ type: 'drop_lines_matching', pattern: '^DEBUG:' }]
                }
            }
        }), 'utf8');

        const lines = ['DEBUG: noise', 'error: important', 'DEBUG: more noise'];
        // Without budgetTokens: original behavior, no tier applied
        const result = applyOutputFilterProfile(lines, configPath, 'test_profile');
        assert.equal(result.budget_tier, null);
        assert.deepEqual(result.lines, ['error: important']);
        assert.equal(result.filter_mode, 'profile:test_profile');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile budget overrides passthrough ceiling', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-budget-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            passthrough_ceiling: { max_lines: 60, strategy: 'tail' },
            budget_profiles: {
                enabled: true,
                tiers: [
                    { label: 'tight', max_tokens: 500, passthrough_ceiling_max_lines: 5, fail_tail_lines: 5, max_matches: 3, max_parser_lines: 4, truncate_line_max_chars: 120 },
                    { label: 'generous', max_tokens: null, passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
                ]
            },
            profiles: {
                passthrough_test: {
                    description: 'Profile that hits parser passthrough',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'compile_failure_summary',
                        strategy: 'maven',
                        max_matches: 12,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        // Lines with no maven error patterns -> parser passthrough -> ceiling applies
        const lines = Array.from({ length: 30 }, (_, i) => `info line ${i}`);
        const result = applyOutputFilterProfile(lines, configPath, 'passthrough_test', { budgetTokens: 300 });
        assert.equal(result.budget_tier, 'tight');
        // Tight tier sets passthrough ceiling to 5 lines + 1 header
        assert.equal(result.lines.length, 6, `expected 6 lines (5 + header), got ${result.lines.length}`);
        assert.match(result.lines[0], /\[passthrough-ceiling\]/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('normalizeErrorSignature strips file path prefix', () => {
    assert.equal(
        normalizeErrorSignature('src/foo/bar.ts:10:5: error TS2345: something wrong'),
        'error TS2345: something wrong'
    );
});

test('normalizeErrorSignature strips Windows-style path prefix', () => {
    assert.equal(
        normalizeErrorSignature('C:\\Users\\dev\\project\\src\\bar.ts:42:1: error TS1234: bad import'),
        'error TS1234: bad import'
    );
});

test('normalizeErrorSignature strips inline parenthesized line/col', () => {
    assert.equal(
        normalizeErrorSignature('error TS2345(10,5): Argument not assignable'),
        'error TS2345: Argument not assignable'
    );
});

test('normalizeErrorSignature anonymizes embedded paths', () => {
    const result = normalizeErrorSignature('Cannot find module /home/user/project/node_modules/foo');
    assert.ok(result.includes('<path>'), `expected anonymized path, got: ${result}`);
});

test('normalizeErrorSignature returns trimmed input for non-path lines', () => {
    assert.equal(normalizeErrorSignature('  BUILD FAILURE  '), 'BUILD FAILURE');
});


test('groupMatchingLines groups duplicate errors', () => {
    const lines = [
        'src/a.ts:1:1: error TS2345: Argument not assignable',
        'src/b.ts:5:2: error TS2345: Argument not assignable',
        'src/c.ts:10:3: error TS2345: Argument not assignable',
        'src/d.ts:2:1: error TS1234: Something else'
    ];
    const result = groupMatchingLines(lines, ['error'], 10);
    assert.equal(result.total_matches, 4);
    assert.equal(result.unique_groups, 2, `expected 2 unique groups, got ${result.unique_groups}`);
    const tsGroup = result.groups.find(g => g.signature.includes('TS2345'));
    assert.ok(tsGroup, 'expected group for TS2345');
    assert.equal(tsGroup!.count, 3);
});

test('groupMatchingLines respects maxGroups limit', () => {
    const lines = [
        'error: alpha',
        'error: beta',
        'error: gamma',
        'error: delta'
    ];
    const result = groupMatchingLines(lines, ['^error'], 2);
    assert.equal(result.groups.length, 2);
    assert.equal(result.unique_groups, 4);
    assert.equal(result.total_matches, 4);
});

test('groupMatchingLines returns zero matches for no-match input', () => {
    const result = groupMatchingLines(['info: ok', 'debug: fine'], ['^error'], 10);
    assert.equal(result.total_matches, 0);
    assert.equal(result.groups.length, 0);
});

test('groupMatchingLines preserves first representative per group', () => {
    const lines = [
        'src/a.ts:1:1: error TS9999: duplicate thing',
        'src/z.ts:99:1: error TS9999: duplicate thing'
    ];
    const result = groupMatchingLines(lines, ['error'], 10);
    assert.equal(result.groups.length, 1);
    assert.ok(result.groups[0].representative.includes('src/a.ts'), 'expected first occurrence as representative');
    assert.equal(result.groups[0].count, 2);
});


test('formatGroupedLines emits count prefix for duplicated groups', () => {
    const result = formatGroupedLines({
        groups: [
            { signature: 'error TS2345: Argument not assignable', representative: 'src/a.ts:1:1: error TS2345: Argument not assignable', count: 3 },
            { signature: 'error TS1234: Something else', representative: 'src/d.ts:2:1: error TS1234: Something else', count: 1 }
        ],
        total_matches: 4,
        unique_groups: 2
    });
    assert.equal(result.length, 2);
    assert.match(result[0], /^\[3×\]/);
    assert.ok(!result[1].startsWith('['), 'single-count lines should not have a count prefix');
});

test('formatGroupedLines adds omission footer when groups are truncated', () => {
    const result = formatGroupedLines({
        groups: [
            { signature: 'error A', representative: 'error A', count: 1 },
            { signature: 'error B', representative: 'error B', count: 1 }
        ],
        total_matches: 10,
        unique_groups: 5
    });
    assert.equal(result.length, 3);
    assert.match(result[2], /3 more distinct error/);
    assert.match(result[2], /10 total matches/);
});

test('formatGroupedLines omits footer when all groups shown', () => {
    const result = formatGroupedLines({
        groups: [
            { signature: 'error X', representative: 'error X', count: 2 }
        ],
        total_matches: 2,
        unique_groups: 1
    });
    assert.equal(result.length, 1);
    assert.match(result[0], /^\[2×\]/);
});


test('compile failure parser groups duplicate node errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                test_compile: {
                    description: 'Test compile',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'compile_failure_summary',
                        strategy: 'node',
                        max_matches: 12,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        const lines = [
            'npm ERR! missing script: build',
            'npm ERR! missing script: build',
            'npm ERR! missing script: build',
            'npm ERR! code ELIFECYCLE',
            'info: other stuff'
        ];
        const result = applyOutputFilterProfile(lines, configPath, 'test_compile');
        assert.equal(result.parser_mode, 'FULL');
        assert.ok(result.lines[0].includes('group(s)'), 'summary header should include group count');
        assert.ok(result.grouping, 'grouping metadata should be present');
        assert.equal(result.grouping!.unique_groups, 2, 'expected 2 distinct groups');
        assert.equal(result.grouping!.total_matches, 4);
        // The duplicate npm ERR! lines should be grouped with count prefix
        assert.ok(result.lines.some(l => l.startsWith('[3×]')), 'expected grouped count prefix');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('test failure parser groups duplicate test failures', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                test_fail: {
                    description: 'Test failure',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'test_failure_summary',
                        max_matches: 16,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        const lines = [
            'FAILED tests/unit/auth.test.ts > login flow',
            'FAILED tests/unit/auth.test.ts > logout flow',
            'FAILED tests/unit/auth.test.ts > refresh token',
            'FAILED tests/integration/api.test.ts > health check',
            'ok some other output'
        ];
        const result = applyOutputFilterProfile(lines, configPath, 'test_fail');
        assert.equal(result.parser_mode, 'FULL');
        assert.ok(result.grouping, 'grouping metadata should be present');
        assert.equal(result.grouping!.total_matches, 4);
        assert.equal(result.grouping!.unique_groups, 4, 'different test names produce distinct groups');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('lint failure parser groups duplicate lint errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                lint_fail: {
                    description: 'Lint failure',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'lint_failure_summary',
                        max_matches: 16,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        const lines = [
            'src/a.ts:10:5 error no-unused-vars',
            'src/b.ts:20:3 error no-unused-vars',
            'src/c.ts:30:1 error no-unused-vars',
            'src/d.ts:40:2 error prefer-const',
            'info: done'
        ];
        const result = applyOutputFilterProfile(lines, configPath, 'lint_fail');
        assert.equal(result.parser_mode, 'FULL');
        assert.ok(result.grouping, 'grouping metadata should be present');
        assert.equal(result.grouping!.unique_groups, 2, 'expected 2 lint groups');
        assert.equal(result.grouping!.total_matches, 4);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile grouping is null for passthrough parser', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                no_match: {
                    description: 'No match',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'compile_failure_summary',
                        strategy: 'maven',
                        max_matches: 12,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        const lines = ['info: clean build', 'all good'];
        const result = applyOutputFilterProfile(lines, configPath, 'no_match');
        assert.equal(result.parser_mode, 'PASSTHROUGH');
        assert.equal(result.grouping, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('applyOutputFilterProfile grouping is null for profile without parser', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                no_parser: {
                    description: 'No parser',
                    operations: [{ type: 'strip_ansi' }]
                }
            }
        }), 'utf8');

        const result = applyOutputFilterProfile(['hello'], configPath, 'no_parser');
        assert.equal(result.grouping, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('groupMatchingLines with maxGroups=0 returns all groups', () => {
    const lines = ['error: A', 'error: B', 'error: C'];
    const result = groupMatchingLines(lines, ['^error'], 0);
    assert.equal(result.groups.length, 3, 'maxGroups=0 should return all groups');
    assert.equal(result.total_matches, 3);
    assert.equal(result.unique_groups, 3);
});

test('compile failure parser DEGRADED path uses grouping', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-group-'));
    try {
        const configPath = path.join(tempDir, 'output-filters.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 2,
            profiles: {
                degraded_test: {
                    description: 'Degraded compile test',
                    operations: [{ type: 'strip_ansi' }],
                    parser: {
                        type: 'compile_failure_summary',
                        strategy: 'maven',
                        max_matches: 12,
                        tail_count: 0
                    }
                }
            }
        }), 'utf8');

        // Lines that match degraded_patterns (lowercase 'error') but NOT full_patterns.
        // File-path prefixes normalize away, grouping identical core messages.
        const lines = [
            'src/a.java:10: error: variable not used',
            'src/b.java:20: error: variable not used',
            'src/c.java:30: error: variable not used',
            'info: compiling',
            'src/d.java:40: error: method not found'
        ];
        const result = applyOutputFilterProfile(lines, configPath, 'degraded_test');
        assert.equal(result.parser_mode, 'DEGRADED');
        assert.ok(result.grouping, 'grouping metadata should be present for DEGRADED');
        assert.equal(result.grouping!.total_matches, 4);
        assert.equal(result.grouping!.unique_groups, 2, 'path-normalized errors form 2 groups');
        assert.ok(result.lines.some(l => l.startsWith('[3×]')), 'duplicate errors should be grouped');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('normalizeErrorSignature preserves bare filename without directory separator', () => {
    const result = normalizeErrorSignature('foo.ts:10:5: error TS1234: bad');
    assert.equal(result, 'foo.ts:10:5: error TS1234: bad', 'bare filename without dir separator stays intact');
});
