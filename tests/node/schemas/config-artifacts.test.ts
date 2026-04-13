import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getManagedConfigValidators,
    validateManagedConfigByName,
    validateOutputFiltersConfig,
    validateTokenEconomyConfig,
    validateProfilesConfig,
    validateReviewArtifactStorageConfig
} from '../../../src/schemas/config-artifacts';

function readTemplateConfig(configName: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'template', 'config', `${configName}.json`), 'utf8')
    );
}

test('tracked template managed configs validate successfully', () => {
    for (const configName of Object.keys(getManagedConfigValidators())) {
        const validated = validateManagedConfigByName(configName, readTemplateConfig(configName));
        assert.ok(validated);
    }
});

test('validateTokenEconomyConfig canonicalizes integer arrays and boolean-like values', () => {
    const normalized = validateTokenEconomyConfig({
        enabled: 'yes',
        enabled_depths: ['3', 1, '2', 2],
        strip_examples: 'true',
        strip_code_blocks: 1,
        scoped_diffs: 'no',
        compact_reviewer_output: false,
        fail_tail_lines: '25'
    });

    assert.equal(normalized.enabled, true);
    assert.deepEqual(normalized.enabled_depths, [1, 2, 3]);
    assert.equal(normalized.scoped_diffs, false);
    assert.equal(normalized.fail_tail_lines, 25);
});

test('validateOutputFiltersConfig accepts context-driven parser controls from the tracked template', () => {
    const normalized = validateOutputFiltersConfig(readTemplateConfig('output-filters'));

    assert.equal(normalized.version, 2);
    const profiles = (normalized as Record<string, unknown>).profiles as Record<string, { parser: { tail_count: { context_key: string } } }>;
    assert.equal(
        profiles.compile_failure_console.parser.tail_count.context_key,
        'fail_tail_lines'
    );
});

// ---------------------------------------------------------------------------
// Profiles config validator
// ---------------------------------------------------------------------------

test('validateProfilesConfig validates template profiles.json', () => {
    const normalized = validateProfilesConfig(readTemplateConfig('profiles'));
    assert.equal(normalized.version, 1);
    assert.equal(normalized.active_profile, 'balanced');

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    assert.ok(builtIn.balanced);
    assert.ok(builtIn.fast);
    assert.ok(builtIn.strict);
    assert.ok(builtIn['docs-only']);
    assert.equal(Object.keys(builtIn).length, 4);

    const user = normalized.user_profiles as Record<string, unknown>;
    assert.equal(Object.keys(user).length, 0);
});

test('validateProfilesConfig normalizes boolean-like review_policy values', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'test',
        built_in_profiles: {
            test: {
                description: 'Test profile',
                depth: 2,
                review_policy: { code: 'yes', db: 'auto', security: 'false' },
                token_economy: { enabled: 'true' },
                skills: { auto_suggest: 1 }
            }
        },
        user_profiles: {}
    });

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    const policy = builtIn.test.review_policy as Record<string, unknown>;
    assert.equal(policy.code, true);
    assert.equal(policy.db, 'auto');
    assert.equal(policy.security, false);
});

test('validateProfilesConfig rejects active_profile pointing to nonexistent profile', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'nonexistent',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /does not match any/);
});

test('validateProfilesConfig rejects user profile name conflicting with built-in', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {
                balanced: {
                    description: 'Conflict', depth: 1,
                    review_policy: { code: false },
                    token_economy: { enabled: false },
                    skills: { auto_suggest: false }
                }
            }
        });
    }, /conflicts with a built-in/);
});

test('validateProfilesConfig rejects empty built_in_profiles', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'any',
            built_in_profiles: {},
            user_profiles: {}
        });
    }, /at least one profile/);
});

test('validateProfilesConfig rejects depth outside 1-3 range', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad depth', depth: 5,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /must be <= 3/);
});

test('validateProfilesConfig allows active_profile to reference a user profile', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {
            balanced: {
                description: 'Built-in', depth: 2,
                review_policy: { code: true },
                token_economy: { enabled: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {
            custom: {
                description: 'Custom', depth: 1,
                review_policy: { code: false },
                token_economy: { enabled: false },
                skills: { auto_suggest: false }
            }
        }
    });

    assert.equal(normalized.active_profile, 'custom');
    const user = normalized.user_profiles as Record<string, Record<string, unknown>>;
    assert.ok(user.custom);
});

test('validateProfilesConfig rejects unknown token_economy keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true, unknown_key: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized token_economy key/);
});

test('validateProfilesConfig rejects unknown skills keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true, unknown_skill: false }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized skills key/);
});

// ---------------------------------------------------------------------------
// validateReviewArtifactStorageConfig
// ---------------------------------------------------------------------------

test('validateReviewArtifactStorageConfig normalizes valid config', () => {
    const input = {
        version: 1,
        retention_mode: 'summary',
        compress_after_days: 14,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json', '-preflight.json'],
        privacy_notice: 'Test notice.'
    };
    const result = validateReviewArtifactStorageConfig(input);
    assert.equal(result.version, 1);
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compress_after_days, 14);
    assert.equal(result.compression_format, 'gzip');
    assert.equal(result.preserve_gate_receipts, true);
    assert.deepEqual(result.gate_receipt_suffixes, ['-task-mode.json', '-preflight.json']);
    assert.equal(result.privacy_notice, 'Test notice.');
});

test('validateReviewArtifactStorageConfig accepts none mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'none',
        compress_after_days: 0,
        compression_format: 'gzip',
        preserve_gate_receipts: false,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'none');
    assert.equal(result.preserve_gate_receipts, false);
});

test('validateReviewArtifactStorageConfig accepts full mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'full',
        compress_after_days: 7,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'full');
});

test('validateReviewArtifactStorageConfig rejects invalid retention_mode', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'invalid',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /retention_mode must be one of/);
});

test('validateReviewArtifactStorageConfig rejects invalid compression_format', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'brotli',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /compression_format must be one of/);
});

test('validateReviewArtifactStorageConfig rejects negative compress_after_days', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: -1,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /must be >= 0/);
});

test('validateReviewArtifactStorageConfig rejects empty gate_receipt_suffixes', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: []
        });
    }, /must not be empty/);
});

test('validateReviewArtifactStorageConfig normalizes case of retention_mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'SUMMARY',
        compress_after_days: 0,
        compression_format: 'GZIP',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compression_format, 'gzip');
});

test('validateReviewArtifactStorageConfig validates template config', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateReviewArtifactStorageConfig(config);
    assert.equal(result.retention_mode, 'full');
    assert.equal(result.compress_after_days, 7);
});

test('validateManagedConfigByName handles review-artifact-storage', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateManagedConfigByName('review-artifact-storage', config);
    assert.equal(result.retention_mode, 'full');
});
