import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function collectMatchingFiles(rootPath: string, extension: string): string[] {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            matches.push(...collectMatchingFiles(entryPath, extension));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(extension)) {
            matches.push(entryPath);
        }
    }

    return matches.sort();
}

test('dist directory does not contain stale JS files from renamed or deleted source files', () => {
    const repoRoot = getRepoRoot();
    const distSrcDir = path.join(repoRoot, 'dist', 'src');
    const srcDir = path.join(repoRoot, 'src');

    if (!fs.existsSync(distSrcDir)) {
        return; // No dist dir, nothing to check.
    }

    const distJsFiles = collectMatchingFiles(distSrcDir, '.js');
    const staleFiles: string[] = [];

    for (const distFile of distJsFiles) {
        const relativePath = path.relative(distSrcDir, distFile);
        const expectedSourcePath = path.join(srcDir, relativePath.replace(/\.js$/, '.ts'));

        if (!fs.existsSync(expectedSourcePath)) {
            staleFiles.push(relativePath.split(path.sep).join('/'));
        }
    }

    assert.deepEqual(staleFiles, [], 'Found stale generated JS files in dist/src without a corresponding .ts file in src/');
});

test('regression: renamed source module leaving an obsolete generated JS file is caught', () => {
    const repoRoot = getRepoRoot();
    const distSrcDir = path.join(repoRoot, 'dist', 'src');
    const srcDir = path.join(repoRoot, 'src');

    // Mock a stale file by creating one temporarily in dist/src and ensuring our logic catches it
    const fakeStaleRelativePath = path.join('core', 'stale-regression-test-fake.js');
    const fakeStalePath = path.join(distSrcDir, fakeStaleRelativePath);

    fs.mkdirSync(path.dirname(fakeStalePath), { recursive: true });
    fs.writeFileSync(fakeStalePath, 'console.log("stale");', 'utf8');

    try {
        const distJsFiles = collectMatchingFiles(distSrcDir, '.js');
        const staleFiles: string[] = [];

        for (const distFile of distJsFiles) {
            const relativePath = path.relative(distSrcDir, distFile);
            const expectedSourcePath = path.join(srcDir, relativePath.replace(/\.js$/, '.ts'));

            if (!fs.existsSync(expectedSourcePath)) {
                staleFiles.push(relativePath.split(path.sep).join('/'));
            }
        }

        const normalizedFakeStaleRelativePath = fakeStaleRelativePath.split(path.sep).join('/');
        assert.ok(
            staleFiles.includes(normalizedFakeStaleRelativePath),
            'The stale checking logic must catch a deliberately placed obsolete JS file'
        );
    } finally {
        if (fs.existsSync(fakeStalePath)) {
            fs.rmSync(fakeStalePath);
        }
    }
});
