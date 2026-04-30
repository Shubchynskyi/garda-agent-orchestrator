import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint
} from '../../../src/gates/review-reuse';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

describe('gates/review-reuse', () => {
    it('fingerprints staged scope from the index instead of the dirty working tree', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-staged-scope-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "alpha";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const preflight = {
                detection_source: 'git_staged_only',
                changed_files: ['src/reviewed.ts']
            };
            const stagedAlphaCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedAlphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "bravo";\n', 'utf8');
            const dirtyWorktreeCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const dirtyWorktreeReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.equal(dirtyWorktreeCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.equal(dirtyWorktreeReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);

            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const stagedBravoCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedBravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.notEqual(stagedBravoCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.notEqual(stagedBravoReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps benchmark and perf support paths inside code-review scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-perf-path-scope-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['benchmark/reviewed.ts', 'apps/shop/perf/cache.ts']
            };
            const alphaScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.deepEqual(alphaScope.non_test_changed_files, ['apps/shop/perf/cache.ts', 'benchmark/reviewed.ts']);

            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "bravo";\n', 'utf8');
            const bravoScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.notEqual(bravoScope.code_scope_sha256, alphaScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps performance-triggered runtime files inside code-review scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-runtime-perf-trigger-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src', 'auth'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'auth', 'TokenCache.ts'), 'export const cache = "alpha";\n', 'utf8');
            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/auth/TokenCache.ts']
            };

            const alphaScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.deepEqual(alphaScope.non_test_changed_files, ['src/auth/TokenCache.ts']);

            fs.writeFileSync(path.join(repoRoot, 'src', 'auth', 'TokenCache.ts'), 'export const cache = "bravo";\n', 'utf8');
            const bravoScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.notEqual(bravoScope.code_scope_sha256, alphaScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('ignores volatile scoped-diff paths and preflight hashes in review-context reuse hash', () => {
        const stableHash = 'a'.repeat(64);
        const baseContext = {
            schema_version: 2,
            review_type: 'security',
            depth: 2,
            token_economy_active: true,
            required_review: true,
            rule_pack: {
                selected_rule_files: ['00-core.md', '70-security.md'],
                omitted_rule_files: [],
                omission_reason: 'none'
            },
            token_economy: {
                active: true,
                flags: { scoped_diffs: true },
                omitted_sections: [],
                omission_reason: 'none'
            },
            rule_context: {
                source_file_count: 2,
                strip_examples_applied: false,
                strip_code_blocks_applied: false,
                source_files: [
                    { path: '00-core.md', sha256: 'b'.repeat(64) },
                    { path: '70-security.md', sha256: 'c'.repeat(64) }
                ]
            },
            scoped_diff: {
                expected: true,
                metadata: {
                    review_type: 'security',
                    preflight_path: 'runtime/reviews/T-1-preflight.json',
                    preflight_sha256: '1'.repeat(64),
                    paths_config_path: 'garda-agent-orchestrator/live/config/paths.json',
                    output_path: 'runtime/reviews/T-1-security-scoped.diff',
                    metadata_path: 'runtime/reviews/T-1-security-scoped.json',
                    changed_files: ['src/security/auth.ts'],
                    matched_files: ['src/security/auth.ts'],
                    changed_files_sha256: 'd'.repeat(64),
                    scope_content_sha256: 'e'.repeat(64),
                    scope_sha256: 'f'.repeat(64),
                    use_staged: false,
                    include_untracked: true,
                    fallback_to_full_diff: false,
                    output_diff_sha256: stableHash,
                    scoped_diff_line_count: 8,
                    output_diff_line_count: 8,
                    hunk_level: false
                }
            },
            reviewer_routing: {
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Codex',
                execution_provider_source: 'explicit_provider',
                identity_status: 'resolved',
                delegation_required: true,
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                reviewer_execution_mode_required: true,
                reviewer_identity_required: true
            },
            plan: {
                plan_guided: false
            }
        };
        const refreshedContext = {
            ...baseContext,
            scoped_diff: {
                expected: true,
                metadata: {
                    ...(baseContext.scoped_diff.metadata),
                    preflight_path: 'runtime/reviews/T-1-preflight-refresh.json',
                    preflight_sha256: '2'.repeat(64),
                    output_path: 'runtime/reviews/T-1-security-scoped-refresh.diff',
                    metadata_path: 'runtime/reviews/T-1-security-scoped-refresh.json'
                }
            }
        };
        const changedDiffContext = {
            ...refreshedContext,
            scoped_diff: {
                expected: true,
                metadata: {
                    ...(refreshedContext.scoped_diff.metadata),
                    output_diff_sha256: '9'.repeat(64)
                }
            }
        };

        assert.equal(computeReviewContextReuseHash(refreshedContext), computeReviewContextReuseHash(baseContext));
        assert.notEqual(computeReviewContextReuseHash(changedDiffContext), computeReviewContextReuseHash(baseContext));
    });
});
