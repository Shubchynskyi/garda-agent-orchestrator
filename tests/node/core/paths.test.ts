import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    isPathInsideRoot,
    isPathRealpathInsideRoot,
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

test('replaced realpath containment rejects an in-root directory link to an outside target', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-path-outside-'));
    try {
        const linkPath = path.join(fixtureRoot, 'linked');
        try {
            fs.symlinkSync(
                outsideRoot,
                linkPath,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) {
                t.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const escapedPath = path.join(linkPath, 'secret.json');
        assert.equal(isPathRealpathInsideRoot(fixtureRoot, escapedPath, { allowMissing: true }), false);
        assert.throws(
            () => resolvePathInsideRoot(fixtureRoot, path.join('linked', 'secret.json')),
            /filesystem link/u
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('replaced realpath containment rejects a dangling in-root symlink', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-path-root-'));
    const missingTarget = path.join(os.tmpdir(), `garda-path-missing-${process.pid}-${Date.now()}`);
    const linkPath = path.join(fixtureRoot, 'dangling.json');
    try {
        try {
            fs.symlinkSync(missingTarget, linkPath, 'file');
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) {
                t.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.equal(fs.existsSync(missingTarget), false);
        assert.equal(isPathRealpathInsideRoot(fixtureRoot, linkPath, { allowMissing: true }), false);
        assert.throws(
            () => resolvePathInsideRoot(fixtureRoot, 'dangling.json'),
            /filesystem link/u
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
