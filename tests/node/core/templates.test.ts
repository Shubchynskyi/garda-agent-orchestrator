import test from 'node:test';
import assert from 'node:assert/strict';

import {
    listTemplateTokens,
    replaceTemplateTokens
} from '../../../src/core/templates';

test('listTemplateTokens returns unique placeholders in encounter order', () => {
    assert.deepEqual(
        listTemplateTokens('Hello {{NAME}} and {{PLACE}} then {{NAME}} again'),
        ['NAME', 'PLACE']
    );
});

test('replaceTemplateTokens only replaces placeholders that were provided', () => {
    assert.equal(
        replaceTemplateTokens('Hello {{NAME}} from {{PLACE}} / {{UNKNOWN}}', {
            NAME: 'Garda',
            PLACE: 'Node'
        }),
        'Hello Garda from Node / {{UNKNOWN}}'
    );
});
