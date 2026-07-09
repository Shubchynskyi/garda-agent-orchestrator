import test from 'node:test';
import assert from 'node:assert/strict';

import { isPlainRecord } from '../../../src/core/records';

test('isPlainRecord accepts object records and rejects null, arrays, and primitives', () => {
    assert.equal(isPlainRecord({}), true);
    assert.equal(isPlainRecord({ value: 1 }), true);
    assert.equal(isPlainRecord(null), false);
    assert.equal(isPlainRecord([]), false);
    assert.equal(isPlainRecord('value'), false);
    assert.equal(isPlainRecord(1), false);
});
