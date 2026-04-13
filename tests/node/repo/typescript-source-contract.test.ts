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

test('maintained source trees stay TypeScript-only', () => {
    const repoRoot = getRepoRoot();
    const jsFiles = ['src', 'scripts', 'tests']
        .flatMap((relativeRoot: string) => collectMatchingFiles(path.join(repoRoot, relativeRoot), '.js'))
        .map((absolutePath: string) => path.relative(repoRoot, absolutePath).split(path.sep).join('/'));

    assert.deepEqual(jsFiles, []);
    assert.ok(
        fs.existsSync(path.join(repoRoot, 'src', 'bin', 'garda.ts')),
        'TS launcher source must exist at src/bin/garda.ts'
    );
});
