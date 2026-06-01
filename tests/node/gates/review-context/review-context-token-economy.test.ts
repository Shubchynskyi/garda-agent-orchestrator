import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
    buildRuleContextSectionsCacheKey,
    getRulePack,
    resolveReviewContextTokenEconomyDecision,
    selectRulePackFiles,
    toNonNegativeInt
} from '../../../../src/gates/review-context/review-context-token-economy';

describe('review-context-token-economy helpers', () => {
    it('selects full rule context when token economy is inactive', () => {
        const repoRoot = path.resolve('D:/workspace/project');
        const decision = resolveReviewContextTokenEconomyDecision({
            reviewType: 'security',
            depth: 1,
            repoRoot,
            tokenConfig: {
                enabled: false,
                enabled_depths: [1, 2],
                strip_examples: true,
                strip_code_blocks: true,
                scoped_diffs: true,
                compact_reviewer_output: true,
                fail_tail_lines: '75'
            }
        });

        assert.equal(decision.tokenEconomyActive, false);
        assert.deepEqual(decision.selectedRuleFiles, getRulePack('security').full);
        assert.deepEqual(decision.omittedRuleFiles, []);
        assert.equal(decision.rulePackOmissionReason, 'none');
        assert.equal(decision.stripExamplesApplied, false);
        assert.equal(decision.stripCodeBlocksApplied, false);
        assert.equal(decision.tokenEconomyOmissionReason, 'none');
        assert.equal(decision.tokenEconomyFlags.fail_tail_lines, 75);
    });

    it('records depth and flag-driven omissions for compact rule context', () => {
        const repoRoot = path.resolve('D:/workspace/project');
        const decision = resolveReviewContextTokenEconomyDecision({
            reviewType: 'refactor',
            depth: 1,
            repoRoot,
            tokenConfig: {
                enabled: true,
                enabled_depths: ['1', '2', '2'],
                strip_examples: true,
                strip_code_blocks: true,
                scoped_diffs: true,
                compact_reviewer_output: false,
                fail_tail_lines: 50
            }
        });

        assert.equal(decision.tokenEconomyActive, true);
        assert.deepEqual(decision.selectedRuleFiles, selectRulePackFiles('refactor', 1));
        assert.deepEqual(decision.omittedRuleFiles, ['30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md']);
        assert.equal(decision.rulePackOmissionReason, 'deferred_by_depth');
        assert.equal(decision.stripExamplesApplied, true);
        assert.equal(decision.stripCodeBlocksApplied, true);
        assert.deepEqual(decision.tokenEconomyFlags.enabled_depths, [1, 2]);
        assert.deepEqual(
            decision.omittedSections.map((section) => section.section),
            ['rule_pack', 'examples', 'code_blocks']
        );
        assert.equal(decision.tokenEconomyOmissionReason, 'token_economy_compaction');
        assert.ok(decision.selectedRulePaths.every((rulePath) => rulePath.includes('/live/docs/agent-rules/')));
    });

    it('keeps full rule pack at depth 3 even when token economy is enabled', () => {
        const decision = resolveReviewContextTokenEconomyDecision({
            reviewType: 'code',
            depth: 3,
            repoRoot: path.resolve('D:/workspace/project'),
            tokenConfig: {
                enabled: true,
                enabled_depths: [1, 2, 3],
                strip_examples: true,
                strip_code_blocks: true
            }
        });

        assert.equal(decision.tokenEconomyActive, true);
        assert.deepEqual(decision.selectedRuleFiles, getRulePack('code').full);
        assert.deepEqual(decision.omittedRuleFiles, []);
        assert.equal(decision.rulePackOmissionReason, 'none');
        assert.deepEqual(
            decision.omittedSections.map((section) => section.section),
            ['examples', 'code_blocks']
        );
    });

    it('builds deterministic rule-context section cache keys', () => {
        const key = buildRuleContextSectionsCacheKey(['a.md', 'b.md'], true, false);
        assert.equal(key, JSON.stringify({
            selectedRulePaths: ['a.md', 'b.md'],
            stripExamples: true,
            stripCodeBlocks: false
        }));
    });

    it('parses non-negative integer token economy values', () => {
        assert.equal(toNonNegativeInt(42), 42);
        assert.equal(toNonNegativeInt('50'), 50);
        assert.equal(toNonNegativeInt(1.9), 1);
        assert.equal(toNonNegativeInt(true), null);
        assert.equal(toNonNegativeInt(-1), null);
        assert.equal(toNonNegativeInt(null), null);
    });
});
