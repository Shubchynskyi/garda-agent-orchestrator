import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    classifyChange,
    classifyScopeCategory,
    getDefaultClassificationConfig,
    getClassificationConfig,
    getReviewCapabilities
} from '../../../src/gates/classify-change';

function makeConfig(overrides: Record<string, unknown> = {}) {
    const defaults = getDefaultClassificationConfig('/repo');
    // re-build flattened config matching getClassificationConfig output shape
    const base = {
        source: 'defaults',
        config_path: '/repo/garda-agent-orchestrator/live/config/paths.json',
        metrics_path: '/repo/garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: defaults.runtime_roots.map(r => r.endsWith('/') ? r : r + '/').sort(),
        fast_path_roots: defaults.fast_path_roots.map(r => r.endsWith('/') ? r : r + '/').sort(),
        fast_path_allowed_regexes: defaults.fast_path_allowed_regexes,
        fast_path_sensitive_regexes: defaults.fast_path_sensitive_regexes,
        sql_or_migration_regexes: defaults.sql_or_migration_regexes,
        db_trigger_regexes: defaults.triggers.db,
        security_trigger_regexes: defaults.triggers.security,
        api_trigger_regexes: defaults.triggers.api,
        dependency_trigger_regexes: defaults.triggers.dependency,
        infra_trigger_regexes: defaults.triggers.infra,
        test_trigger_regexes: defaults.triggers.test,
        performance_trigger_regexes: defaults.triggers.performance,
        code_like_regexes: defaults.code_like_regexes,
        protected_control_plane_roots: defaults.protected_control_plane_roots
    };
    return { ...base, ...overrides };
}

const defaultCapabilities = {
    code: true, db: true, security: true, refactor: true,
    api: false, test: false, performance: false, infra: false, dependency: false
};

describe('gates/classify-change', () => {
    describe('getDefaultClassificationConfig', () => {
        it('returns valid default config with triggers', () => {
            const config = getDefaultClassificationConfig('/repo');
            assert.ok(config.triggers);
            assert.ok(config.triggers.db.length > 0);
            assert.ok(config.triggers.security.length > 0);
            assert.ok(config.runtime_roots.length > 0);
            assert.ok(config.code_like_regexes.length > 0);
        });
    });

    describe('classifyChange', () => {
        it('returns FAST_PATH for small frontend change', () => {
            const result = classifyChange({
                normalizedFiles: ['frontend/Button.tsx'],
                taskIntent: 'Update button styles',
                changedLinesTotal: 10,
                additionsTotal: 8,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FAST_PATH');
            assert.equal(result.triggers.fast_path_eligible, true);
            assert.equal(result.required_reviews.code, false);
        });

        it('returns FULL_PATH for large backend change', () => {
            const result = classifyChange({
                normalizedFiles: ['src/service/UserService.java', 'src/model/User.java', 'src/controller/UserController.java'],
                taskIntent: 'Add user management',
                changedLinesTotal: 200,
                additionsTotal: 150,
                deletionsTotal: 50,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FULL_PATH');
            assert.equal(result.required_reviews.code, true);
        });

        it('triggers db review for migration files', () => {
            const result = classifyChange({
                normalizedFiles: ['src/db/migrations/001_init.sql'],
                taskIntent: 'DB migration',
                changedLinesTotal: 50,
                additionsTotal: 50,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.db, true);
            assert.equal(result.required_reviews.db, true);
        });

        it('triggers security review for auth files', () => {
            const result = classifyChange({
                normalizedFiles: ['src/auth/JwtProvider.ts'],
                taskIntent: 'Fix auth',
                changedLinesTotal: 20,
                additionsTotal: 15,
                deletionsTotal: 5,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.security, true);
            assert.equal(result.required_reviews.security, true);
        });

        it('matches security triggers case-insensitively for java config paths', () => {
            const result = classifyChange({
                normalizedFiles: ['api-gateway/src/main/java/com/acme/security/SecurityConfig.java'],
                taskIntent: 'Tighten security rules',
                changedLinesTotal: 18,
                additionsTotal: 12,
                deletionsTotal: 6,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.security, true);
            assert.equal(result.required_reviews.security, true);
        });

        it('allows small frontend package state updates to stay on fast path', () => {
            const result = classifyChange({
                normalizedFiles: ['store-frontend/src/store/cart-store.ts'],
                taskIntent: 'Adjust cart store labels',
                changedLinesTotal: 12,
                additionsTotal: 8,
                deletionsTotal: 4,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FAST_PATH');
            assert.equal(result.triggers.fast_path_eligible, true);
            assert.equal(result.required_reviews.code, false);
        });

        it('triggers refactor review from task intent', () => {
            const result = classifyChange({
                normalizedFiles: ['src/utils.ts'],
                taskIntent: 'Refactor utility functions',
                changedLinesTotal: 30,
                additionsTotal: 20,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.refactor_intent, true);
            assert.equal(result.triggers.refactor, true);
            assert.equal(result.required_reviews.refactor, true);
        });

        it('triggers dependency review for package.json', () => {
            const result = classifyChange({
                normalizedFiles: ['package.json'],
                taskIntent: 'Update deps',
                changedLinesTotal: 5,
                additionsTotal: 3,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, dependency: true }
            });
            assert.equal(result.triggers.dependency, true);
            assert.equal(result.required_reviews.dependency, true);
        });

        it('detects balanced structural churn as refactor heuristic', () => {
            const result = classifyChange({
                normalizedFiles: [
                    'src/A.ts', 'src/B.ts', 'src/C.ts', 'src/D.ts'
                ],
                taskIntent: '',
                changedLinesTotal: 100,
                additionsTotal: 50,
                deletionsTotal: 50,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.triggers.refactor_heuristic, true);
            assert.ok(result.triggers.refactor_heuristic_reasons.includes('balanced_structural_churn'));
        });

        it('disables api review if capability is false', () => {
            const result = classifyChange({
                normalizedFiles: ['src/controllers/UserController.ts'],
                taskIntent: '',
                changedLinesTotal: 30,
                additionsTotal: 20,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, api: false }
            });
            assert.equal(result.triggers.api, true);
            assert.equal(result.required_reviews.api, false);
        });

        it('returns empty reviews for no changed files', () => {
            const result = classifyChange({
                normalizedFiles: [],
                taskIntent: '',
                changedLinesTotal: 0,
                additionsTotal: 0,
                deletionsTotal: 0,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.equal(result.mode, 'FULL_PATH');
            assert.equal(result.required_reviews.code, false);
            assert.equal(result.changed_files.length, 0);
            assert.equal(result.zero_diff_guard.zero_diff_detected, true);
            assert.equal(result.zero_diff_guard.status, 'BASELINE_ONLY');
            assert.equal(result.zero_diff_guard.completion_requires_audited_no_op, true);
        });

        it('preserves changed_files in output', () => {
            const files = ['src/a.ts', 'src/b.ts'];
            const result = classifyChange({
                normalizedFiles: files,
                taskIntent: '',
                changedLinesTotal: 20,
                additionsTotal: 10,
                deletionsTotal: 10,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });
            assert.deepEqual(result.changed_files, files);
            assert.equal(result.detection_source, 'explicit_changed_files');
        });

        it('does not treat ordinary project bin/dist/src-cli paths as protected control-plane in a normal workspace', () => {
            const result = classifyChange({
                normalizedFiles: ['src/cli/app.ts', 'dist/app.js', 'bin/run.js'],
                taskIntent: 'Update app runtime',
                changedLinesTotal: 25,
                additionsTotal: 20,
                deletionsTotal: 5,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, false);
            assert.deepEqual(result.triggers.changed_protected_files, []);
        });

        it('treats deployed bundle runtime paths as protected control-plane', () => {
            const result = classifyChange({
                normalizedFiles: ['garda-agent-orchestrator/src/cli/main.ts'],
                taskIntent: 'Patch orchestrator runtime',
                changedLinesTotal: 12,
                additionsTotal: 9,
                deletionsTotal: 3,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.deepEqual(result.triggers.changed_protected_files, ['garda-agent-orchestrator/src/cli/main.ts']);
        });

        it('treats root-level agent control-plane files as protected control-plane', () => {
            const result = classifyChange({
                normalizedFiles: ['AGENTS.md', '.github/agents/orchestrator.md'],
                taskIntent: 'Patch agent control plane',
                changedLinesTotal: 8,
                additionsTotal: 6,
                deletionsTotal: 2,
                renameCount: 0,
                detectionSource: 'explicit_changed_files',
                classificationConfig: makeConfig(),
                reviewCapabilities: defaultCapabilities
            });

            assert.equal(result.triggers.protected_control_plane_changed, true);
            assert.deepEqual(result.triggers.changed_protected_files, ['AGENTS.md', '.github/agents/orchestrator.md']);
        });

        it('treats root-level orchestrator source paths as protected only in the self-hosted source checkout', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-protected-roots-'));
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');

            try {
                const result = classifyChange({
                    normalizedFiles: ['src/cli/main.ts'],
                    taskIntent: 'Patch orchestrator source',
                    changedLinesTotal: 12,
                    additionsTotal: 9,
                    deletionsTotal: 3,
                    renameCount: 0,
                    detectionSource: 'explicit_changed_files',
                    classificationConfig: getClassificationConfig(repoRoot),
                    reviewCapabilities: defaultCapabilities
                });

                assert.equal(result.triggers.protected_control_plane_changed, true);
                assert.deepEqual(result.triggers.changed_protected_files, ['src/cli/main.ts']);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    });
});

// ---------------------------------------------------------------------------
// classifyScopeCategory (T-059)
// ---------------------------------------------------------------------------

describe('classifyScopeCategory', () => {
    const codeLikeRegexes = ['\\.(ts|tsx|js|jsx|java|py|go)$'];
    const runtimeRoots = ['src/', 'app/', 'packages/'];

    it('classifies empty file list as empty', () => {
        const result = classifyScopeCategory([], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'empty');
    });

    it('classifies runtime code files as code', () => {
        const result = classifyScopeCategory(['src/main.ts', 'src/utils.ts'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'code');
    });

    it('classifies doc-only changes as docs-only', () => {
        const result = classifyScopeCategory(['README.md', 'docs/guide.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'docs-only');
    });

    it('classifies config-only changes as config-only', () => {
        const result = classifyScopeCategory(['tsconfig.json', '.editorconfig'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'config-only');
    });

    it('classifies orchestrator control-plane files as audit-only', () => {
        const result = classifyScopeCategory(
            ['TASK.md', 'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json'],
            codeLikeRegexes,
            runtimeRoots
        );
        assert.equal(result.category, 'audit-only');
    });

    it('classifies mixed code+docs as mixed', () => {
        const result = classifyScopeCategory(['src/main.ts', 'README.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'mixed');
    });

    it('classifies code+config as mixed', () => {
        const result = classifyScopeCategory(['src/main.ts', 'tsconfig.json'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'mixed');
    });

    it('classifies docs+config as docs-only (all_non_code)', () => {
        const result = classifyScopeCategory(['README.md', 'tsconfig.json'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'docs-only');
        assert.ok(result.reasons.includes('all_non_code'));
    });

    it('classifies CHANGELOG.md as docs-only', () => {
        const result = classifyScopeCategory(['CHANGELOG.md'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'docs-only');
    });

    it('classifies unknown file types under runtime roots as code (safety default)', () => {
        const result = classifyScopeCategory(['src/data.bin'], codeLikeRegexes, runtimeRoots);
        assert.equal(result.category, 'code');
    });

    it('classifyChange output includes scope_category', () => {
        const result = classifyChange({
            normalizedFiles: ['src/main.ts'],
            taskIntent: 'refactor',
            changedLinesTotal: 10,
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        assert.ok('scope_category' in result);
        assert.ok('scope_category_reasons' in result);
        assert.equal(result.scope_category, 'code');
    });

    it('classifyChange: docs-only files produce docs-only scope', () => {
        const result = classifyChange({
            normalizedFiles: ['README.md', 'docs/guide.md'],
            taskIntent: 'update docs',
            changedLinesTotal: 20,
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        assert.equal(result.scope_category, 'docs-only');
    });
});
