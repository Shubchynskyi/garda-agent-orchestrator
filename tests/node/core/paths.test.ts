import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isPathInsideRoot,
    normalizeRelativePath,
    resolvePathInsideRoot
} from '../../../src/core/paths';

test('normalizeRelativePath canonicalizes separators for repo-relative paths', () => {
    assert.equal(normalizeRelativePath('.\\src\\core\\paths.ts'), 'src/core/paths.ts');
});

test('isPathInsideRoot respects platform-specific case sensitivity', () => {
    assert.equal(isPathInsideRoot('C:\\Repo', 'c:\\repo\\src\\index.ts', 'win32'), true);
    assert.equal(isPathInsideRoot('/repo', '/Repo/src/index.ts', 'linux'), false);
});

test('resolvePathInsideRoot rejects path traversal outside the root', () => {
    assert.throws(
        () => resolvePathInsideRoot('/repo', '../outside.txt', 'linux'),
        /escapes root/
    );
});
