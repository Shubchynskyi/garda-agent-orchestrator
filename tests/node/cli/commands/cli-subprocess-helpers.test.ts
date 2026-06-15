import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
    acquireSourceRoot,
    buildSourceCloneArgs,
    runProcess
} from '../../../../src/cli/commands/cli-subprocess-helpers';

function listGardaSourceTempRoots(): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('garda-source-')));
}

test('buildSourceCloneArgs preserves setup clone branch semantics', () => {
    assert.deepEqual(
        buildSourceCloneArgs('https://example.com/repo.git', undefined, 'C:/tmp/source'),
        ['clone', '--quiet', '--depth', '1', 'https://example.com/repo.git', 'C:/tmp/source']
    );
    assert.deepEqual(
        buildSourceCloneArgs('https://example.com/repo.git', 'main', 'C:/tmp/source'),
        ['clone', '--quiet', '--depth', '1', '--branch', 'main', '--single-branch', 'https://example.com/repo.git', 'C:/tmp/source']
    );
});

test('runProcess reports timeout with captured diagnostics', async () => {
    await assert.rejects(
        runProcess(process.execPath, [
            '-e',
            "process.stdout.write('stdout diagnostic'); process.stderr.write('stderr diagnostic'); setInterval(() => {}, 1000);"
        ], {
            description: 'node timeout diagnostic',
            timeoutMs: 50
        }),
        (error) => {
            const message = (error as Error).message;
            assert.match(message, /node timeout diagnostic timed out after 50 ms/u);
            assert.match(message, /stderr diagnostic/u);
            assert.match(message, /stdout diagnostic/u);
            return true;
        }
    );
});

test('acquireSourceRoot times out git clone and cleans the temporary source root', async () => {
    const before = listGardaSourceTempRoots();
    let runnerCalled = false;
    let runnerDestination = '';
    let runnerTimeoutMs = 0;

    await assert.rejects(
        acquireSourceRoot('https://example.com/slow.git', undefined, process.cwd(), {
            cloneTimeoutMs: 100,
            processRunner: async (executableName, args, options) => {
                runnerCalled = true;
                runnerDestination = args.at(-1) || '';
                runnerTimeoutMs = options?.timeoutMs || 0;
                assert.equal(executableName, 'git');
                assert.deepEqual(args.slice(0, -1), ['clone', '--quiet', '--depth', '1', 'https://example.com/slow.git']);
                throw new Error('git clone from https://example.com/slow.git timed out after 100 ms.');
            }
        }),
        (error) => {
            const message = (error as Error).message;
            assert.match(message, /git clone from https:\/\/example\.com\/slow\.git timed out after 100 ms/u);
            return true;
        }
    );

    assert.equal(runnerCalled, true);
    assert.equal(runnerTimeoutMs, 100);
    assert.equal(fs.existsSync(runnerDestination), false, 'temporary clone destination should be removed');
    const after = listGardaSourceTempRoots();
    for (const entry of after) {
        assert.equal(before.has(entry), true, `temporary source root should be cleaned: ${entry}`);
    }
});
