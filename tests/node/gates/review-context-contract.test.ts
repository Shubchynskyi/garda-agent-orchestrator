import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations,
    reviewContextScopedDiffRequired
} from '../../../src/gates/review-context-contract';

const CURRENT_PREFLIGHT_SHA256 = 'a'.repeat(64);
const CURRENT_CHANGED_FILES_SHA256 = 'b'.repeat(64);
const CURRENT_SCOPE_CONTENT_SHA256 = 'c'.repeat(64);
const CURRENT_SCOPE_SHA256 = 'd'.repeat(64);
const CURRENT_OUTPUT_DIFF_SHA256 = 'e'.repeat(64);

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        review_type: 'code',
        task_id: 'T-272',
        preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        preflight_sha256: CURRENT_PREFLIGHT_SHA256,
        task_scope: {
            changed_files: ['src/app.ts'],
            diff: {
                available: true,
                source: 'git_diff_head_plus_untracked',
                char_count: 120
            }
        },
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-code-scoped.json',
            metadata: null
        },
        ...overrides
    };
}

function validate(reviewContext: Record<string, unknown>, overrides: Record<string, unknown> = {}): string[] {
    return getReviewContextContractViolations({
        contextPath: 'garda-agent-orchestrator/runtime/reviews/T-272-code-review-context.json',
        reviewContext,
        expectedTaskId: 'T-272',
        expectedReviewType: 'code',
        expectedPreflightPath: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        expectedPreflightSha256: CURRENT_PREFLIGHT_SHA256,
        requireReviewType: true,
        requireTaskId: true,
        requirePreflightPath: true,
        requirePreflightSha256: true,
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/app.ts'],
        expectedScopeCategory: 'code',
        expectedChangedFilesSha256: CURRENT_CHANGED_FILES_SHA256,
        expectedScopeContentSha256: CURRENT_SCOPE_CONTENT_SHA256,
        expectedScopeSha256: CURRENT_SCOPE_SHA256,
        validateScopedDiffOutputFile: false,
        ...overrides
    });
}

function validScopedMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        review_type: 'security',
        preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-272-preflight.json',
        preflight_sha256: CURRENT_PREFLIGHT_SHA256,
        changed_files_sha256: CURRENT_CHANGED_FILES_SHA256,
        scope_content_sha256: CURRENT_SCOPE_CONTENT_SHA256,
        scope_sha256: CURRENT_SCOPE_SHA256,
        output_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.diff',
        metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
        changed_files: ['src/app.ts'],
        output_diff_sha256: CURRENT_OUTPUT_DIFF_SHA256,
        output_diff_line_count: 8,
        ...overrides
    };
}

test('review-context contract rejects required code review contexts without task diff material', () => {
    const violations = validate(baseContext({
        task_scope: {
            changed_files: ['src/app.ts'],
            diff: { available: false, source: 'git_diff_head', char_count: 0 }
        }
    }));

    assert.ok(violations.some((violation) => violation.includes('no task diff material')));
    assert.ok(violations.some((violation) => violation.includes('src/app.ts')));
});

test('review-context contract rejects expected scoped diff metadata when it is missing', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security'
    });

    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
    assert.ok(violations.some((violation) => violation.includes('T-272-security-scoped.json')));
});

test('review-context contract rejects spoofed scoped diff opt-out when preflight requires metadata', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('must declare scoped_diff.expected=true')));
    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
});

test('review-context contract rejects scoped diff metadata not bound to the current preflight scope', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                review_type: 'refactor',
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/OLD-preflight.json',
                output_path: 'garda-agent-orchestrator/runtime/reviews/OLD-security-scoped.diff',
                metadata_path: 'garda-agent-orchestrator/runtime/reviews/OLD-security-scoped.json',
                changed_files: ['src/old.ts']
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale review_type')));
    assert.ok(violations.some((violation) => violation.includes('stale preflight_path')));
    assert.ok(violations.some((violation) => violation.includes('stale metadata_path')));
    assert.ok(violations.some((violation) => violation.includes('changed_files does not match')));
});

test('review-context contract rejects scoped diff metadata from an older preflight with the same files', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                preflight_sha256: 'e'.repeat(64),
                changed_files_sha256: 'f'.repeat(64),
                scope_content_sha256: '0'.repeat(64),
                scope_sha256: '1'.repeat(64)
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale preflight_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale changed_files_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale scope_content_sha256')));
    assert.ok(violations.some((violation) => violation.includes('stale scope_sha256')));
});

test('review-context contract accepts scoped diff metadata bound to the current preflight scope', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata()
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true
    });

    assert.deepEqual(violations, []);
});

test('review-context contract rejects scoped diff metadata with stale staged mode', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: validScopedMetadata({
                use_staged: false
            })
        }
    }), {
        expectedReviewType: 'security',
        expectedScopedDiff: true,
        expectedScopedDiffUseStaged: true
    });

    assert.ok(violations.some((violation) => violation.includes('stale use_staged')));
});

test('review-context contract rejects scoped diff output files that no longer match metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = 'diff --git a/src/app.ts b/src/app.ts\n+export const value = true;\n';

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const reviewContext = baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        });
        assert.deepEqual(validate(reviewContext, {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        }), []);

        fs.writeFileSync(outputPath, 'diff --git a/src/app.ts b/src/app.ts\n+tampered\n', 'utf8');
        const violations = validate(reviewContext, {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('stale output_diff_sha256')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects scoped diff output files with diff blocks outside preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-expanded-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        'diff --git a/src/unrelated.ts b/src/unrelated.ts',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects headerless diff content outside preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-headerless-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects headerless mixed-scope marker pairs after a hunk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-headerless-mixed-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        '--- a/src/app.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('contains files outside the current preflight scope')));
        assert.ok(violations.some((violation) => violation.includes('src/unrelated.ts')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects scoped diff output files with unparseable diff block paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-unparseable-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git --broken-header',
        '--- a/src/unrelated.ts',
        '+++ b/src/unrelated.ts',
        '@@ -1 +1 @@',
        '-export const unrelated = false;',
        '+export const unrelated = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.ok(violations.some((violation) => violation.includes('unparseable path')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts custom scoped diff output path when the file hash matches metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-custom-output-'));
    const metadataPath = path.join(tempDir, 'metadata', 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'custom-output', 'review.diff');
    const outputText = 'diff --git a/src/app.ts b/src/app.ts\n+export const value = true;\n';

    try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts hunk content that looks like diff header markers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-hunk-marker-content-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,2 @@',
        '-- export const oldMarker = true;',
        '++ export const newMarker = true;',
        ' export const stable = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText)
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract accepts rename diffs when the new path is in preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-contract-rename-output-'));
    const metadataPath = path.join(tempDir, 'T-272-security-scoped.json');
    const outputPath = path.join(tempDir, 'T-272-security-scoped.diff');
    const outputText = [
        'diff --git a/src/old-app.ts b/src/app.ts',
        'similarity index 88%',
        'rename from src/old-app.ts',
        'rename to src/app.ts',
        '--- a/src/old-app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1 @@',
        '-export const value = false;',
        '+export const value = true;',
        ''
    ].join('\n');

    try {
        fs.writeFileSync(outputPath, outputText, 'utf8');
        const violations = validate(baseContext({
            review_type: 'security',
            task_scope: {
                changed_files: ['src/app.ts'],
                diff: {
                    available: true,
                    source: 'git_diff_head_plus_untracked',
                    char_count: 120
                }
            },
            scoped_diff: {
                expected: true,
                metadata_path: metadataPath,
                metadata: validScopedMetadata({
                    metadata_path: metadataPath,
                    output_path: outputPath,
                    output_diff_sha256: sha256Text(outputText),
                    changed_files: ['src/app.ts']
                })
            }
        }), {
            expectedReviewType: 'security',
            expectedScopedDiff: true,
            expectedChangedFiles: ['src/app.ts'],
            validateScopedDiffOutputFile: true
        });

        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('review-context contract rejects expected scoped diff metadata even for docs-only scopes', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        task_scope: {
            changed_files: ['docs/usage.md'],
            diff: { available: false, source: 'none', char_count: 0 }
        },
        scoped_diff: {
            expected: true,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedChangedFiles: ['docs/usage.md'],
        expectedScopeCategory: 'docs-only'
    });

    assert.ok(violations.some((violation) => violation.includes('expects scoped diff metadata')));
});

test('review-context contract does not require task diff material for docs-only scopes without scoped diff expectation', () => {
    const violations = validate(baseContext({
        review_type: 'security',
        task_scope: {
            changed_files: ['docs/usage.md'],
            diff: { available: false, source: 'none', char_count: 0 }
        },
        scoped_diff: {
            expected: false,
            metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-272-security-scoped.json',
            metadata: null
        }
    }), {
        expectedReviewType: 'security',
        expectedChangedFiles: ['docs/usage.md'],
        expectedScopeCategory: 'docs-only'
    });

    assert.deepEqual(violations, []);
});

test('preflight diff expectations require scoped diff only for active specialist code reviews', () => {
    const preflight = {
        scope_category: 'code',
        changed_files: ['src/auth.ts'],
        required_reviews: { security: true, code: true },
        budget_forecast: { token_economy_active_for_depth: true },
        risk_aware_depth: { compression: { scoped_diffs: true } }
    };

    assert.equal(buildReviewContextPreflightDiffExpectations(preflight, 'security').expectedScopedDiff, true);
    assert.equal(buildReviewContextPreflightDiffExpectations(preflight, 'code').expectedScopedDiff, false);
    assert.equal(buildReviewContextPreflightDiffExpectations({
        ...preflight,
        detection_source: 'git_staged_only'
    }, 'security').expectedScopedDiffUseStaged, true);
    assert.equal(buildReviewContextPreflightDiffExpectations({
        ...preflight,
        scope_category: 'docs-only',
        changed_files: ['docs/usage.md']
    }, 'security').expectedScopedDiff, false);
    assert.equal(reviewContextScopedDiffRequired({
        reviewType: 'security',
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/auth.ts'],
        expectedScopeCategory: 'code',
        tokenEconomyActiveForDepth: true,
        scopedDiffsEnabled: true
    }), true);
    assert.equal(reviewContextScopedDiffRequired({
        reviewType: 'code',
        expectedRequiredReview: true,
        expectedChangedFiles: ['src/auth.ts'],
        expectedScopeCategory: 'code',
        tokenEconomyActiveForDepth: true,
        scopedDiffsEnabled: true
    }), false);
});
