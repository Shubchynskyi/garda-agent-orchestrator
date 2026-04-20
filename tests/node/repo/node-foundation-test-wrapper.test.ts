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
    spawnSync: typeof childProcess.spawnSync;
};

function createBuildResultFixture(): { buildResult: BuildResult; cleanup: () => void; } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-tests-'));
    const buildRoot = path.join(repoRoot, '.node-build');
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'cli', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(buildRoot, 'tests', 'node', 'repo'), { recursive: true });

    const compiledGateTest = path.join(buildRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.js');
    const compiledRepoTest = path.join(buildRoot, 'tests', 'node', 'repo', 'build-root-serialization.test.js');
    fs.writeFileSync(compiledGateTest, 'void 0;\n', 'utf8');
    fs.writeFileSync(compiledRepoTest, 'void 0;\n', 'utf8');

    return {
        buildResult: {
            repoRoot,
            buildRoot,
            copiedFiles: [
                'tests/node/cli/commands/gates.test.js',
                'tests/node/repo/build-root-serialization.test.js'
            ],
            generatedCliPath: path.join(buildRoot, 'bin', 'garda.js'),
            manifestPath: path.join(buildRoot, 'node-foundation-manifest.json')
        },
        cleanup() {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    };
}

test('runNodeFoundationTests forwards test-name-pattern args before compiled test files', () => {
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

        testModule.runNodeFoundationTests();

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

test('runNodeFoundationTests narrows explicit source test targets to compiled outputs', () => {
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

        testModule.runNodeFoundationTests();

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

test('runNodeFoundationTests fails fast when an explicit test target cannot be resolved', () => {
    const { buildResult, cleanup } = createBuildResultFixture();
    const originalArgv = process.argv;
    const originalBuildNodeFoundation = mutableBuildModule.buildNodeFoundation;
    const originalBuildPublishRuntime = mutableBuildModule.buildPublishRuntime;

    try {
        process.argv = ['node', 'scripts/node-foundation/test.js', 'tests/node/missing.test.ts'];
        mutableBuildModule.buildPublishRuntime = () => buildResult;
        mutableBuildModule.buildNodeFoundation = () => buildResult;

        assert.throws(
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
