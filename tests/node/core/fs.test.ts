import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pathExists, readTextFile, writeTextFile } from '../../../src/core/fs';
import { readJsonFile, writeJsonFile } from '../../../src/core/json';

test('writeTextFile creates parent directories and normalizes line endings', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'nested', 'file.txt');
        writeTextFile(targetPath, 'alpha\r\nbeta\r\n', { newline: '\n', trailingNewline: true });

        assert.equal(pathExists(targetPath), true);
        assert.equal(readTextFile(targetPath), 'alpha\nbeta\n');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('writeJsonFile persists deterministic JSON with a trailing newline', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'config.json');
        writeJsonFile(targetPath, { enabled: true, depths: [1, 2] });

        assert.deepEqual(readJsonFile(targetPath), { enabled: true, depths: [1, 2] });
        assert.match(fs.readFileSync(targetPath, 'utf8'), /\n$/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
