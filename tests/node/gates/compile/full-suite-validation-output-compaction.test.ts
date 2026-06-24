import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compactGreenSummary,
    compactRedFailureChunks} from '../../../../src/gates/full-suite/full-suite-validation';





describe('gates/full-suite-validation', () => {
    describe('compactGreenSummary', () => {
        it('returns pass message for empty output', () => {
            const result = compactGreenSummary([], 5);
            assert.equal(result.length, 1);
            assert.ok(result[0].includes('passed'));
        });

        it('extracts node:test tail summary', () => {
            const lines = [
                '# tests 15',
                '# suites 3',
                '# pass 15',
                '# fail 0',
                '# duration_ms 1234'
            ];
            const result = compactGreenSummary(lines, 5);
            assert.ok(result.some((line) => line.includes('# pass 15')));
            assert.ok(result.some((line) => line.includes('# duration_ms 1234')));
        });
    });

    describe('compactRedFailureChunks', () => {
        it('extracts failure chunks with context', () => {
            const lines = [
                'ok 1 - a',
                'not ok 2 - b',
                'error at src/unrelated.ts:5',
                'detail line',
                'ok 3 - c'
            ];
            const result = compactRedFailureChunks(lines, 10);
            assert.ok(result.length >= 1);
            assert.ok(result.flat().some((line) => line.includes('not ok 2 - b')));
        });
    });
});
