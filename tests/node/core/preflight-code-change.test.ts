import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    detectCodeChanged,
    preflightRequiresAnyReview
} from '../../../src/core/preflight-code-change';

describe('core/preflight-code-change', () => {
    it('uses self-contained modern preflight evidence without a gate dependency', () => {
        assert.equal(detectCodeChanged({
            scope_category: 'docs-only',
            changed_files: ['docs/runbook.md'],
            metrics: { changed_lines_total: 4 },
            required_reviews: { code: false }
        }), false);
        assert.equal(detectCodeChanged({
            scope_category: 'code',
            changed_files: ['src/main.ts'],
            required_reviews: { code: false }
        }), true);
        assert.equal(preflightRequiresAnyReview({
            required_reviews: { code: false, test: true }
        }), true);
    });

    it('delegates legacy changed-file classification through an injected boundary', () => {
        let receivedRepoRoot = '';
        const result = detectCodeChanged({
            changed_files: ['docs/runbook.md'],
            metrics: { changed_lines_total: 4 }
        }, '/workspace', (changedFiles, repoRoot) => {
            assert.deepEqual(changedFiles, ['docs/runbook.md']);
            receivedRepoRoot = repoRoot;
            return 'docs-only';
        });

        assert.equal(receivedRepoRoot, '/workspace');
        assert.equal(result, false);
    });

    it('preserves canonical legacy classification precedence in the dependency-safe fallback', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-core-preflight-code-change-'));
        try {
            const configDirectory = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config'
            );
            fs.mkdirSync(configDirectory, { recursive: true });
            fs.writeFileSync(path.join(configDirectory, 'paths.json'), JSON.stringify({
                code_like_regexes: ['\\.ts$'],
                runtime_roots: ['src/'],
                ordinary_doc_paths: ['docs/**'],
                protected_control_plane_roots: ['custom/control/'],
                sql_or_migration_regexes: ['(^|/)database(/|$)'],
                triggers: {
                    security: ['(^|/)auth(/|\\.|$)']
                }
            }));

            assert.equal(detectCodeChanged({
                changed_files: ['config/auth/settings.json'],
                metrics: { changed_lines_total: 1 }
            }, repoRoot), false);
            assert.equal(detectCodeChanged({
                changed_files: ['custom/control/policy.bin'],
                metrics: { changed_lines_total: 1 }
            }, repoRoot), false);
            assert.equal(detectCodeChanged({
                changed_files: ['docs/auth/runbook.md'],
                metrics: { changed_lines_total: 1 }
            }, repoRoot), false);
            fs.writeFileSync(path.join(configDirectory, 'paths.json'), JSON.stringify({
                code_like_regexes: ['\\.ts$'],
                runtime_roots: ['src/'],
                ordinary_doc_paths: ['docs/**'],
                protected_control_plane_roots: ['custom/control/'],
                sql_or_migration_regexes: [],
                triggers: {
                    db: [],
                    security: ['(^|/)auth(/|\\.|$)'],
                    api: [],
                    dependency: []
                }
            }));
            assert.equal(detectCodeChanged({
                changed_files: ['docs/database/runbook.md'],
                metrics: { changed_lines_total: 1 }
            }, repoRoot), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
