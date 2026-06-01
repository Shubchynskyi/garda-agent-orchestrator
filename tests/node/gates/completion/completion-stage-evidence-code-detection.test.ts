import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    detectCodeChanged,
    preflightRequiresAnyReview
} from '../../../../src/gates/completion';

describe('gates/completion — stage and evidence validation', () => {
    describe('detectCodeChanged', () => {
        it('detects when preflight requires any review', () => {
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: true
                }
            }), true);
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: false
                }
            }), false);
        });

        it('returns false for docs-only preflight with non-zero diff but no code-like changes or required reviews', () => {
            const result = detectCodeChanged({
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: false
                }
            });

            assert.equal(result, false);
        });

        it('returns false for other explicit non-code scope categories without required reviews', () => {
            const scopeCategories = ['config-only', 'audit-only', 'empty'];
            for (const scopeCategory of scopeCategories) {
                const result = detectCodeChanged({
                    scope_category: scopeCategory,
                    changed_files: scopeCategory === 'empty' ? [] : [`meta/${scopeCategory}.txt`],
                    metrics: {
                        changed_lines_total: scopeCategory === 'empty' ? 0 : 5,
                        code_like_changed_count: 0,
                        runtime_code_like_changed_count: 0
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    },
                    triggers: {
                        runtime_code_changed: false
                    }
                });

                assert.equal(result, false, `Expected ${scopeCategory} to remain non-code.`);
            }
        });

        it('returns false for legacy docs-only preflight artifacts without new classifier fields', () => {
            const result = detectCodeChanged({
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12
                },
                required_reviews: {
                    code: false,
                    test: false
                }
            });

            assert.equal(result, false);
        });

        it('uses workspace paths config for legacy fallback classification', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-paths-'));

            try {
                const configPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify({
                    runtime_roots: ['docs/'],
                    code_like_regexes: ['\\.md$']
                }, null, 2), 'utf8');

                const result = detectCodeChanged({
                    changed_files: ['docs/runbook.md'],
                    metrics: {
                        changed_lines_total: 12
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    }
                }, tempDir);

                assert.equal(result, true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('returns true when reviews are required even if code-like metrics are absent', () => {
            const result = detectCodeChanged({
                changed_files: ['src/main.ts'],
                required_reviews: {
                    code: true,
                    test: true
                }
            });

            assert.equal(result, true);
        });
    });
});
