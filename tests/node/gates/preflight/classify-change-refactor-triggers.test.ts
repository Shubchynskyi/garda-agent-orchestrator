import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import { defaultCapabilities, makeConfig } from './classify-change-test-support';

describe('gates/classify-change refactor triggers', () => {
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

    it('triggers refactor review for decomposition and split task intents', () => {
        const decomposeResult = classifyChange({
            normalizedFiles: ['src/ui-dashboard-html.ts'],
            taskIntent: 'Decompose ui-dashboard-html into focused modules',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        const splitResult = classifyChange({
            normalizedFiles: ['src/ui-dashboard-html.ts'],
            taskIntent: 'Split tab renderers out of ui-dashboard-html.ts',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        const splitIntoModulesResult = classifyChange({
            normalizedFiles: ['src/ui-dashboard-html.ts'],
            taskIntent: 'Split ui-dashboard-html into focused modules',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });
        const modularizeResult = classifyChange({
            normalizedFiles: ['src/ui-dashboard-html.ts'],
            taskIntent: 'Modularize dashboard rendering helpers',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });

        for (const result of [decomposeResult, splitResult, splitIntoModulesResult, modularizeResult]) {
            assert.equal(result.triggers.refactor_intent, true);
            assert.equal(result.triggers.refactor, true);
            assert.equal(result.required_reviews.refactor, true);
        }
    });

    it('does not trigger refactor review for unrelated split wording', () => {
        const result = classifyChange({
            normalizedFiles: ['tests/node/fixtures/split-data.test.ts'],
            taskIntent: 'Split test data fixtures across scenarios',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });

        assert.equal(result.triggers.refactor_intent, false);
        assert.equal(result.triggers.refactor, false);
        assert.equal(result.required_reviews.refactor, false);
    });

    it('does not trigger refactor review for split data into scenarios wording', () => {
        const result = classifyChange({
            normalizedFiles: ['tests/node/fixtures/split-data.test.ts'],
            taskIntent: 'Split test data into scenarios',
            changedLinesTotal: 30,
            additionsTotal: 20,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: defaultCapabilities
        });

        assert.equal(result.triggers.refactor_intent, false);
        assert.equal(result.triggers.refactor, false);
        assert.equal(result.required_reviews.refactor, false);
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

    it('does not trigger refactor heuristic for pure test-only churn under runtime roots', () => {
        const result = classifyChange({
            normalizedFiles: [
                'src/test/cart.test.ts',
                'src/test/order.test.ts',
                'packages/orders/tests/order-flow.test.ts'
            ],
            taskIntent: 'Update test fixtures',
            changedLinesTotal: 100,
            additionsTotal: 50,
            deletionsTotal: 50,
            renameCount: 0,
            detectionSource: 'explicit_changed_files',
            classificationConfig: makeConfig({
                runtime_roots: ['src/', 'packages/']
            }),
            reviewCapabilities: { ...defaultCapabilities, test: true }
        });

        assert.equal(result.scope_category, 'test-only');
        assert.equal(result.triggers.refactor, false);
        assert.equal(result.triggers.refactor_heuristic, false);
        assert.equal(result.required_reviews.refactor, false);
        assert.equal(result.required_reviews.test, true);
    });
});
