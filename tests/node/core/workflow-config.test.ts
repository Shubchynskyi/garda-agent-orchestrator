import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildDefaultWorkflowConfig,
    isExactLegacyReviewCycleGuardGeneratedDefault,
    mergeWorkflowConfigWithTemplate,
    syncWorkflowConfigWithTemplate
} from '../../../src/core/workflow-config';

function mkTmpBundle(): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-config-'));
    fs.mkdirSync(path.join(bundleRoot, 'template', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return bundleRoot;
}

function captureStderr(callback: () => void): string {
    const originalWrite = process.stderr.write;
    let output = '';
    (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
        output += String(chunk);
        return true;
    };
    try {
        callback();
    } finally {
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
    return output;
}

describe('workflow config template diagnostics', () => {
    it('warns when workflow-config template JSON is malformed before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '{ invalid json',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=invalid_json_template:/);
            const materialized = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.equal(materialized.full_suite_validation.enabled, false);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('warns when workflow-config template JSON is not an object before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '[]',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=non_object_template/);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });
});

describe('workflow config review cycle guard defaults', () => {
    it('migrates the exact previous generated default to ten failed reviews', () => {
        const previousGeneratedDefault = {
            enabled: true,
            action: 'BLOCK_FOR_OPERATOR_DECISION',
            max_failed_non_test_reviews: 15,
            max_total_non_test_reviews: 30,
            excluded_review_types: ['test'],
            auto_split_enabled: true
        };

        assert.equal(isExactLegacyReviewCycleGuardGeneratedDefault(previousGeneratedDefault), true);

        const merged = mergeWorkflowConfigWithTemplate(buildDefaultWorkflowConfig(), {
            review_cycle_guard: previousGeneratedDefault
        });
        const reviewCycleGuard = merged.review_cycle_guard as Record<string, unknown>;
        assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 10);
    });

    it('preserves a custom failed-review limit', () => {
        const merged = mergeWorkflowConfigWithTemplate(buildDefaultWorkflowConfig(), {
            review_cycle_guard: {
                enabled: true,
                action: 'BLOCK_FOR_OPERATOR_DECISION',
                max_failed_non_test_reviews: 12,
                max_total_non_test_reviews: 30,
                excluded_review_types: ['test'],
                auto_split_enabled: true
            }
        });
        const reviewCycleGuard = merged.review_cycle_guard as Record<string, unknown>;
        assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 12);
    });
});
