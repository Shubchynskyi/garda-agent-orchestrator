import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    createGateFixture,
    gateFixtureOperatorConfirmationArgs
} from './gate-fixtures';

describe('shared gate fixture foundation', () => {
    it('creates canonical TASK.md queue rows with the 9-column shape', () => {
        const fixture = createGateFixture({
            taskId: 'T-shared-fixture',
            title: 'Shared fixture contract',
            area: 'tests/shared',
            notes: 'canonical row'
        });
        try {
            const taskText = fs.readFileSync(path.join(fixture.repoRoot, 'TASK.md'), 'utf8');

            assert.match(taskText, /\| ID \| Status \| Priority \| Area \| Title \| Owner \| Updated \| Profile \| Notes \|/);
            assert.match(taskText, /\| T-shared-fixture\s+\| 🟦 TODO\s+\| P1\s+\| tests\/shared\s+\| Shared fixture contract\s+\| gpt-5\.3-codex\s+\| 2026-05-24\s+\| balanced\s+\| canonical row\s+\|/);
        } finally {
            fixture.cleanup();
        }
    });

    it('returns reusable guarded operator confirmation arguments', () => {
        assert.deepEqual(
            gateFixtureOperatorConfirmationArgs('2026-05-24T00:00:00.000Z'),
            [
                '--operator-confirmed',
                'yes',
                '--operator-confirmed-at-utc',
                '2026-05-24T00:00:00.000Z'
            ]
        );
    });
});
