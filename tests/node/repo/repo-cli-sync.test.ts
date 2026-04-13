import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { syncRepoCliEntrypoint } from '../../../scripts/node-foundation/build';

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createRepoCliFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-repo-cli-sync-'));
    const compiledRoot = path.join(tempRoot, 'compiled');
    const repoRoot = path.join(tempRoot, 'repo');
    const compiledCliPath = path.join(compiledRoot, 'src', 'bin', 'garda.js');
    const repoCliPath = path.join(repoRoot, 'bin', 'garda.js');
    const desiredContent = '#!/usr/bin/env node\nconsole.log("new launcher");\n';

    writeTextFile(compiledCliPath, desiredContent);
    writeTextFile(repoCliPath, '#!/usr/bin/env node\nconsole.log("old launcher");\n');

    return {
        tempRoot,
        compiledRoot,
        repoRoot,
        repoCliPath,
        desiredContent
    };
}

function runRepoCliSyncWorker(buildModulePath: string, compiledRoot: string, repoRoot: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const { syncRepoCliEntrypoint } = require(process.argv[1]);",
            "syncRepoCliEntrypoint(process.argv[2], process.argv[3]);"
        ].join('\n');

        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            buildModulePath,
            compiledRoot,
            repoRoot
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `repo-cli sync worker exited with code ${code}`));
        });
    });
}

test('syncRepoCliEntrypoint tolerates transient EBUSY when peer already updated launcher', () => {
    const fixture = createRepoCliFixture();
    let renameAttempts = 0;

    try {
        const repoCliPath = syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot, {
            chmodSync: fs.chmodSync.bind(fs),
            existsSync: fs.existsSync.bind(fs),
            mkdirSync: fs.mkdirSync.bind(fs),
            readFileSync: fs.readFileSync.bind(fs),
            rmSync: fs.rmSync.bind(fs),
            writeFileSync: fs.writeFileSync.bind(fs),
            renameSync(oldPath: fs.PathLike, newPath: fs.PathLike) {
                renameAttempts += 1;
                if (renameAttempts === 1) {
                    fs.writeFileSync(String(newPath), fixture.desiredContent, 'utf8');
                    const error = new Error('launcher temporarily busy') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return fs.renameSync(oldPath, newPath);
            }
        });
        const binEntries = fs.readdirSync(path.dirname(fixture.repoCliPath));

        assert.equal(repoCliPath, fixture.repoCliPath);
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
        assert.equal(renameAttempts, 1);
        assert.ok(!binEntries.some((entry) => entry.endsWith('.tmp')), 'temp launcher files must be cleaned up');
        assert.ok(!binEntries.includes('.garda-cli-sync.lock'), 'lock directory must be removed after sync');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint serializes concurrent workers without leaving temp files', async () => {
    const fixture = createRepoCliFixture();
    const buildModulePath = path.resolve(__dirname, '../../../scripts/node-foundation/build.js');

    try {
        await Promise.all([
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot),
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot),
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot)
        ]);

        const binEntries = fs.readdirSync(path.dirname(fixture.repoCliPath));
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
        assert.ok(!binEntries.some((entry) => entry.endsWith('.tmp')), 'temp launcher files must be cleaned up');
        assert.ok(!binEntries.includes('.garda-cli-sync.lock'), 'lock directory must be removed after sync');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});
