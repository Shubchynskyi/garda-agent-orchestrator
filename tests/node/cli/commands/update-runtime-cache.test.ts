import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageJsonLike } from '../../../../src/cli/commands/cli-types';
import {
    buildUpdateLifecycleRunner,
    invalidateBundleRuntimeModuleCache
} from '../../../../src/cli/commands/shared-command-utils';

type UpdateCommandModule = typeof import('../../../../src/cli/commands/update-command');

function makeCacheModule(resolvedPath: string, exportsValue: Record<string, unknown>): NodeJS.Module {
    return {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        path: path.dirname(resolvedPath),
        exports: exportsValue,
        parent: null,
        children: [],
        paths: [],
        isPreloading: false
    } as unknown as NodeJS.Module;
}

function makeTempBundleRoot(): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-runtime-cache-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    return bundleRoot;
}

function cleanupTempRoot(bundleRoot: string): void {
    fs.rmSync(path.dirname(bundleRoot), { recursive: true, force: true });
}

function writeModule(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
}

function restoreCachedModule(resolvedPath: string, originalModule: NodeJS.Module | undefined): void {
    if (originalModule) {
        require.cache[resolvedPath] = originalModule;
        return;
    }
    delete require.cache[resolvedPath];
}

function loadFreshUpdateCommandWithStubs(stubs: Record<string, Record<string, unknown>>): {
    module: UpdateCommandModule;
    restore(): void;
} {
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const moduleSnapshots = new Map<string, NodeJS.Module | undefined>();

    moduleSnapshots.set(updateCommandPath, require.cache[updateCommandPath]);
    for (const [resolvedPath, exportsValue] of Object.entries(stubs)) {
        moduleSnapshots.set(resolvedPath, require.cache[resolvedPath]);
        require.cache[resolvedPath] = makeCacheModule(resolvedPath, exportsValue);
    }
    delete require.cache[updateCommandPath];

    return {
        module: require(updateCommandPath) as UpdateCommandModule,
        restore() {
            for (const [resolvedPath, originalModule] of moduleSnapshots.entries()) {
                restoreCachedModule(resolvedPath, originalModule);
            }
        }
    };
}

function buildRunnerOptions(targetRoot: string) {
    return {
        targetRoot,
        initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
        noPrompt: true,
        skipVerify: false,
        skipManifestValidation: false,
        trustPolicy: 'explicit',
        trustOverrideUsed: false,
        trustOverrideSource: 'none',
        sourceType: 'path',
        sourceReference: 'fixture'
    };
}

describe('update runtime module cache invalidation', () => {
    it('command handlers invalidate cached bundle runtime modules after successful apply or rollback', async () => {
        const bundleRoot = makeTempBundleRoot();
        const projectRoot = path.dirname(bundleRoot);
        const statePath = path.join(bundleRoot, 'dist', 'src', 'shared', 'runtime-state.js');
        const packageJson: PackageJsonLike = {
            name: 'garda-agent-orchestrator',
            version: '1.0.0'
        };
        const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
        const updateGitModulePath = require.resolve('../../../../src/lifecycle/update-git');
        const rollbackModulePath = require.resolve('../../../../src/lifecycle/rollback');

        try {
            writeModule(statePath, "module.exports = { marker: 'bundle-runtime' };\n");

            require(statePath);
            assert.notEqual(require.cache[require.resolve(statePath)], undefined);
            {
                const reloaded = loadFreshUpdateCommandWithStubs({
                    [checkUpdateModulePath]: {
                        async runCheckUpdate() {
                            return {
                                updateApplied: true,
                                checkUpdateResult: 'UPDATED'
                            };
                        }
                    }
                });

                try {
                    await reloaded.module.handleUpdate([
                        '--target-root', projectRoot,
                        '--no-prompt',
                        '--trust-override',
                        '--json'
                    ], packageJson);
                } finally {
                    reloaded.restore();
                }
            }
            assert.equal(require.cache[require.resolve(statePath)], undefined);

            require(statePath);
            assert.notEqual(require.cache[require.resolve(statePath)], undefined);
            {
                const reloaded = loadFreshUpdateCommandWithStubs({
                    [updateGitModulePath]: {
                        async runUpdateFromGit() {
                            return {
                                updateApplied: true,
                                checkUpdateResult: 'UPDATED'
                            };
                        }
                    }
                });

                try {
                    await reloaded.module.handleUpdateGit([
                        '--target-root', projectRoot,
                        '--no-prompt',
                        '--trust-override',
                        '--json'
                    ], packageJson);
                } finally {
                    reloaded.restore();
                }
            }
            assert.equal(require.cache[require.resolve(statePath)], undefined);

            require(statePath);
            assert.notEqual(require.cache[require.resolve(statePath)], undefined);
            {
                const reloaded = loadFreshUpdateCommandWithStubs({
                    [checkUpdateModulePath]: {
                        async runCheckUpdate() {
                            return {
                                updateApplied: true,
                                checkUpdateResult: 'UPDATED'
                            };
                        }
                    }
                });

                try {
                    await reloaded.module.handleCheckUpdate([
                        '--target-root', projectRoot,
                        '--apply',
                        '--no-prompt',
                        '--trust-override',
                        '--json'
                    ], packageJson);
                } finally {
                    reloaded.restore();
                }
            }
            assert.equal(require.cache[require.resolve(statePath)], undefined);

            require(statePath);
            assert.notEqual(require.cache[require.resolve(statePath)], undefined);
            {
                const reloaded = loadFreshUpdateCommandWithStubs({
                    [rollbackModulePath]: {
                        async runRollback() {
                            return {
                                rollbackMode: 'snapshot',
                                restoreStatus: 'SUCCESS'
                            };
                        }
                    }
                });

                try {
                    await reloaded.module.handleRollback([
                        '--target-root', projectRoot,
                        '--json'
                    ], packageJson);
                } finally {
                    reloaded.restore();
                }
            }
            assert.equal(require.cache[require.resolve(statePath)], undefined);
        } finally {
            cleanupTempRoot(bundleRoot);
        }
    });

    it('buildUpdateLifecycleRunner reloads transitive bundle modules after bundle contents change', () => {
        const bundleRoot = makeTempBundleRoot();
        try {
            const updatePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'update.js');
            const migrationsPath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'contract-migrations.js');
            const verifyPath = path.join(bundleRoot, 'dist', 'src', 'validators', 'verify.js');
            const manifestPath = path.join(bundleRoot, 'dist', 'src', 'validators', 'validate-manifest.js');
            const statePath = path.join(bundleRoot, 'dist', 'src', 'shared', 'runtime-state.js');

            writeModule(statePath, "module.exports = { version: 'v1' };\n");
            writeModule(updatePath, [
                "const state = require('../shared/runtime-state');",
                'module.exports.runUpdate = function runUpdate() {',
                '    return {',
                '        previousVersion: state.version,',
                '        updatedVersion: state.version,',
                "        rollbackSnapshotPath: 'snapshot',",
                "        rollbackStatus: 'NOT_TRIGGERED'",
                '    };',
                '};'
            ].join('\n'));
            writeModule(migrationsPath, "module.exports.runContractMigrations = function runContractMigrations() { return { changed: false }; };\n");
            writeModule(verifyPath, "module.exports.runVerify = function runVerify() { return { passed: true, violations: [] }; };\n");
            writeModule(manifestPath, "module.exports.validateManifest = function validateManifest() { return { passed: true, errors: [] }; };\n");

            const runLifecycle = buildUpdateLifecycleRunner(bundleRoot, false);
            const firstResult = runLifecycle(buildRunnerOptions(path.dirname(bundleRoot)));
            assert.equal(firstResult.previousVersion, 'v1');

            writeModule(statePath, "module.exports = { version: 'v2' };\n");
            const secondResult = runLifecycle(buildRunnerOptions(path.dirname(bundleRoot)));
            assert.equal(secondResult.previousVersion, 'v2');
        } finally {
            cleanupTempRoot(bundleRoot);
        }
    });

    it('invalidateBundleRuntimeModuleCache clears only bundle runtime modules in full-tree mode', () => {
        const bundleRoot = makeTempBundleRoot();
        try {
            const updateCommandPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'update-command.js');
            const rollbackPath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'rollback.js');
            const statePath = path.join(bundleRoot, 'dist', 'src', 'shared', 'runtime-state.js');
            const outsideModulePath = path.join(path.dirname(bundleRoot), 'outside-cache-fixture.js');

            writeModule(statePath, "module.exports = { marker: 'bundle-runtime' };\n");
            writeModule(rollbackPath, [
                "const state = require('../shared/runtime-state');",
                'module.exports.runRollback = function runRollback() {',
                '    return state.marker;',
                '};'
            ].join('\n'));
            writeModule(updateCommandPath, [
                "const rollback = require('../../lifecycle/rollback');",
                'module.exports.handleRollback = function handleRollback() {',
                '    return rollback.runRollback();',
                '};'
            ].join('\n'));
            writeModule(outsideModulePath, "module.exports = { marker: 'outside' };\n");

            require(updateCommandPath);
            require(rollbackPath);
            require(outsideModulePath);

            const invalidated = invalidateBundleRuntimeModuleCache(bundleRoot);
            const normalizedInvalidated = new Set(invalidated.map((entry: string) => path.resolve(entry)));

            assert.equal(normalizedInvalidated.has(path.resolve(updateCommandPath)), true);
            assert.equal(normalizedInvalidated.has(path.resolve(rollbackPath)), true);
            assert.equal(normalizedInvalidated.has(path.resolve(statePath)), true);
            assert.equal(require.cache[require.resolve(updateCommandPath)], undefined);
            assert.equal(require.cache[require.resolve(rollbackPath)], undefined);
            assert.equal(require.cache[require.resolve(statePath)], undefined);
            assert.notEqual(require.cache[require.resolve(outsideModulePath)], undefined);
        } finally {
            cleanupTempRoot(bundleRoot);
        }
    });

    it('runCliMain reloads the runtime entrypoint from cache between calls in a long-lived process', async () => {
        const mainPath = require.resolve('../../../../src/cli/main');
        const runtimeMainPath = require.resolve('../../../../src/cli/runtime-main');

        const originalMainModule = require.cache[mainPath];
        const originalRuntimeMainModule = require.cache[runtimeMainPath];

        const calls: string[] = [];

        require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
            async runCliRuntimeMain() {
                calls.push('v1');
            },
            async runCliRuntimeMainWithHandling() {
                calls.push('v1-handled');
            }
        });
        delete require.cache[mainPath];

        try {
            const reloadedMainModule = require('../../../../src/cli/main') as typeof import('../../../../src/cli/main');

            await reloadedMainModule.runCliMain(['status'], 'stub-package-root');

            require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
                async runCliRuntimeMain() {
                    calls.push('v2');
                },
                async runCliRuntimeMainWithHandling() {
                    calls.push('v2-handled');
                }
            });

            await reloadedMainModule.runCliMain(['status'], 'stub-package-root');

            assert.deepEqual(calls, ['v1', 'v2']);
        } finally {
            if (originalMainModule) {
                require.cache[mainPath] = originalMainModule;
            } else {
                delete require.cache[mainPath];
            }
            if (originalRuntimeMainModule) {
                require.cache[runtimeMainPath] = originalRuntimeMainModule;
            } else {
                delete require.cache[runtimeMainPath];
            }
        }
    });

    it('runCliMainWithHandling reloads the handled runtime entrypoint from cache between calls in a long-lived process', async () => {
        const mainPath = require.resolve('../../../../src/cli/main');
        const runtimeMainPath = require.resolve('../../../../src/cli/runtime-main');

        const originalMainModule = require.cache[mainPath];
        const originalRuntimeMainModule = require.cache[runtimeMainPath];

        const calls: string[] = [];

        require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
            async runCliRuntimeMain() {
                calls.push('v1');
            },
            async runCliRuntimeMainWithHandling() {
                calls.push('v1-handled');
            }
        });
        delete require.cache[mainPath];

        try {
            const reloadedMainModule = require('../../../../src/cli/main') as typeof import('../../../../src/cli/main');

            await reloadedMainModule.runCliMainWithHandling(['status'], 'stub-package-root');

            require.cache[runtimeMainPath] = makeCacheModule(runtimeMainPath, {
                async runCliRuntimeMain() {
                    calls.push('v2');
                },
                async runCliRuntimeMainWithHandling() {
                    calls.push('v2-handled');
                }
            });

            await reloadedMainModule.runCliMainWithHandling(['status'], 'stub-package-root');

            assert.deepEqual(calls, ['v1-handled', 'v2-handled']);
        } finally {
            restoreCachedModule(mainPath, originalMainModule);
            restoreCachedModule(runtimeMainPath, originalRuntimeMainModule);
        }
    });
});
