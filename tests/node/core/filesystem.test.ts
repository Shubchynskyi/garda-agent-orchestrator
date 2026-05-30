import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pathExists, readTextFile, writeFileAtomically, writeTextFile } from '../../../src/core/filesystem';
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

test('writeFileAtomically preserves existing file content when file fsync fails', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'state.json');
        fs.writeFileSync(targetPath, '{"old":true}\n', 'utf8');

        const realFs = require('node:fs');
        const originalFsyncSync = realFs.fsyncSync;
        let intercepted = false;
        try {
            realFs.fsyncSync = function (...args: any[]) {
                if (!intercepted) {
                    intercepted = true;
                    throw new Error('simulated fsync failure');
                }
                return originalFsyncSync.apply(realFs, args);
            };

            assert.throws(
                () => writeFileAtomically(targetPath, '{"new":true}\n', { encoding: 'utf8' }),
                /simulated fsync failure/
            );
        } finally {
            realFs.fsyncSync = originalFsyncSync;
        }

        assert.equal(intercepted, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"old":true}\n');
        assert.deepStrictEqual(
            fs.readdirSync(tempRoot).filter((entry) => entry.includes('.tmp-')),
            []
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('writeFileAtomically preserves existing file mode where POSIX mode bits are supported', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'restricted.json');
        fs.writeFileSync(targetPath, '{"old":true}\n', 'utf8');
        if (process.platform === 'win32') {
            writeFileAtomically(targetPath, '{"new":true}\n', { encoding: 'utf8' });
            assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"new":true}\n');
            return;
        }

        fs.chmodSync(targetPath, 0o600);

        writeFileAtomically(targetPath, '{"new":true}\n', { encoding: 'utf8' });

        assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"new":true}\n');
        assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('writeFileAtomically preserves content when fchmod metadata preservation is rejected', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'state.json');
        fs.writeFileSync(targetPath, '{"old":true}\n', 'utf8');

        const realFs = require('node:fs');
        const originalFchmodSync = realFs.fchmodSync;
        let intercepted = false;
        try {
            realFs.fchmodSync = function (..._args: any[]) {
                intercepted = true;
                const error = new Error('ENOTSUP: simulated unsupported fchmod') as NodeJS.ErrnoException;
                error.code = 'ENOTSUP';
                throw error;
            };

            writeFileAtomically(targetPath, '{"new":true}\n', { encoding: 'utf8' });
        } finally {
            realFs.fchmodSync = originalFchmodSync;
        }

        assert.equal(intercepted, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"new":true}\n');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('writeFileAtomically rethrows unexpected fchmod metadata preservation failures', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'state.json');
        fs.writeFileSync(targetPath, '{"old":true}\n', 'utf8');

        const realFs = require('node:fs');
        const originalFchmodSync = realFs.fchmodSync;
        let intercepted = false;
        try {
            realFs.fchmodSync = function (..._args: any[]) {
                intercepted = true;
                const error = new Error('EBADF: simulated invalid descriptor') as NodeJS.ErrnoException;
                error.code = 'EBADF';
                throw error;
            };

            assert.throws(
                () => writeFileAtomically(targetPath, '{"new":true}\n', { encoding: 'utf8' }),
                /simulated invalid descriptor/
            );
        } finally {
            realFs.fchmodSync = originalFchmodSync;
        }

        assert.equal(intercepted, true);
        assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"old":true}\n');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
