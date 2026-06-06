import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BuildResult } from '../../../scripts/node-foundation/build';

const testModule = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
const mutableBuildModule = require('../../../scripts/node-foundation/build') as typeof import('../../../scripts/node-foundation/build') & {
    buildNodeFoundation: () => BuildResult;
    buildPublishRuntime: () => BuildResult;
};
const mutableChildProcess = require('node:child_process') as typeof childProcess & {
    spawn: typeof childProcess.spawn;
    spawnSync: typeof childProcess.spawnSync;
};

function createBuildResultFixture(extraTestCount = 0): { buildResult: BuildResult; cleanup: () => void; } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-tests-'));
    const buildRoot = path.join(repoRoot, '.node-build');
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'cli', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'repo'), { recursive: true });

    const compiledGateTest = path.join(buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js');
    const compiledRepoTest = path.join(buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js');
    fs.writeFileSync(compiledGateTest, 'void 0;\n', 'utf8');
    fs.writeFileSync(compiledRepoTest, 'void 0;\n', 'utf8');

    const copiedFiles = [
        'tests/node/cli/commands/gates.test.js',
        'tests/node/repo/build-root-serialization.test.js'
    ];
    for (let index = 0; index < extraTestCount; index += 1) {
        const relativePath = `tests/node/repo/auto-shard-long-path-${String(index).padStart(4, '0')}-padding-padding-padding-padding.test.js`;
        const compiledPath = path.join(buildRoot, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
        fs.writeFileSync(compiledPath, 'void 0;\n', 'utf8');
        copiedFiles.push(relativePath);
    }

    return {
        buildResult: {
            repoRoot,
            buildRoot,
            copiedFiles,
            generatedCliPath: path.join(buildRoot, 'bin', 'garda.js'),
            manifestPath: path.join(buildRoot, 'node-foundation-manifest.json')
        },
        cleanup() {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    };
}

test('runNodeFoundationTests forwards test-name-pattern args before compiled test files', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    let observedCommand = '';
    let observedArgs: string[] = [];

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', '--test-name-pattern', 'status sync'];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawnSync = ((command: string, args: readonly string[] = [], options?: childProcess.SpawnSyncOptions) => {
            observedCommand = command;
            observedArgs = Array.from(args);
            void options;
            return { status: 0 } as childProcess.SpawnSyncReturns<Buffer>;
        }) as typeof childProcess.spawnSync;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.equal(observedCommand, process.execPath);
        assert.deepEqual(observedArgs, [
            '--test',
            '--test-name-pattern',
            'status sync',
            path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js'),
            path.join(buildResult.buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js')
        ]);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawnSync = originalSpawnSync;
        cleanup();
    }
});

test('runNodeFoundationTests narrows explicit source test targets to compiled outputs', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    let observedArgs: string[] = [];

    try {
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            '--test-name-pattern',
            'status sync',
            'tests/node/cli/commands/gates.test.ts'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawnSync = ((_: string, args: readonly string[] = []) => {
            observedArgs = Array.from(args);
            return { status: 0 } as childProcess.SpawnSyncReturns<Buffer>;
        }) as typeof childProcess.spawnSync;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.deepEqual(observedArgs, [
            '--test',
            '--test-name-pattern',
            'status sync',
            path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
        ]);
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawnSync = originalSpawnSync;
        cleanup();
    }
});

test('runNodeFoundationTests fails fast when an explicit test target cannot be resolved', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', 'tests/node/missing.test.ts'];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;

        await assert.rejects(
            () => testModule.runNodeFoundationTests(),
            /Unable to resolve targeted Node foundation test path: tests\/node\/missing\.test\.ts/
        );
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        cleanup();
    }
});

test('runNodeFoundationTests runs prebuilt compiled tests in deterministic shards and aggregates failures', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)();
            const exitCode = observedShardArgs.length === 2 ? 7 : 0;
            setImmediate(() => events.emit('exit', exitCode));
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 7);
        assert.equal(observedShardArgs.length, 2);
        assert.deepEqual(observedShardArgs[0], [
            '--test',
            path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')
        ]);
        assert.deepEqual(observedShardArgs[1], [
            '--test',
            path.join(buildResult.buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js')
        ]);
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests auto-shards when the compiled test command would be too long', async () => {
    const { buildResult, cleanup } = createBuildResultFixture(260);
    const originalArgv = process.argv;
    const originalShardEnv = process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawn = mutableChildProcess.spawn;
    const observedShardArgs: string[][] = [];

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js'];
        delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawn = ((_: string, args: readonly string[] = []) => {
            observedShardArgs.push(Array.from(args));
            const events = new (require('node:events').EventEmitter)();
            setImmediate(() => events.emit('exit', 0));
            return events as childProcess.ChildProcess;
        }) as typeof childProcess.spawn;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        assert.ok(observedShardArgs.length > 1, `Expected auto-sharding, got ${observedShardArgs.length} shard(s).`);
        assert.ok(observedShardArgs.every((args) => args[0] === '--test'));
    } finally {
        process.argv = originalArgv;
        if (originalShardEnv === undefined) {
            delete process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS;
        } else {
            process.env.GARDA_NODE_FOUNDATION_TEST_SHARDS = originalShardEnv;
        }
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawn = originalSpawn;
        cleanup();
    }
});

test('runNodeFoundationTests expands a directory fileTarget to all .test.js files under it', async () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    let observedArgs: string[] = [];

    try {
        // Pass the directory 'tests/node/cli/commands' as a fileTarget.
        process.argv = [
            'node',
            'scripts/node-foundation/test.js',
            'tests/node/cli/commands'
        ];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;
        mutableChildProcess.spawnSync = ((_: string, args: readonly string[] = []) => {
            observedArgs = Array.from(args);
            return { status: 0 } as childProcess.SpawnSyncReturns<Buffer>;
        }) as typeof childProcess.spawnSync;

        const exitCode = await testModule.runNodeFoundationTests();

        assert.equal(exitCode, 0);
        // The directory target should have expanded to the gates.test.js file inside cli/commands.
        assert.ok(
            observedArgs.includes(path.join(buildResult.buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js')),
            `Expected expanded directory file in args, got: ${JSON.stringify(observedArgs)}`
        );
    } finally {
        process.argv = originalArgv;
        mutableBuildModule.buildNodeFoundation = originalBuildNodeFoundation;
        mutableBuildModule.buildPublishRuntime = originalBuildPublishRuntime;
        mutableChildProcess.spawnSync = originalSpawnSync;
        cleanup();
    }
});
