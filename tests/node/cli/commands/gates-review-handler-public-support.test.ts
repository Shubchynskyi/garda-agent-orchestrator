import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../../scripts/node-foundation/build';

test('review-handler-public-support stays a narrow re-export facade', () => {
    const repoRoot = getRepoRoot();
    const facadePath = path.join(repoRoot, 'src', 'cli', 'commands', 'gate-review-handlers', 'review-handler-public-support.ts');
    const facade = fs.readFileSync(facadePath, 'utf8');
    const nonBlankLines = facade.split(/\r?\n/u).filter((line) => line.trim()).length;

    assert.ok(nonBlankLines <= 90, `review-handler-public-support.ts should stay a narrow facade, got ${nonBlankLines} nonblank lines`);
    assert.equal(/\bfunction\s+\w+/u.test(facade), false, 'facade must not grow local helper functions');
    assert.equal(/\bimport\b/u.test(facade), false, 'facade should re-export focused helpers without direct imports');
});
