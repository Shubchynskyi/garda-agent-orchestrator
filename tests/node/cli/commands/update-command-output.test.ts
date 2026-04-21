import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageJsonLike } from '../../../../src/cli/commands/cli-types';

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

function makeTempBundleFixture(): { workspaceRoot: string; bundleUpdateModulePath: string; cleanup(): void } {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-command-output-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const bundleUpdateModulePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'update.js');
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src', 'lifecycle'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        bundleUpdateModulePath,
        [
            'module.exports.runUpdate = function runUpdate() {',
            '    return {',
            "        previousVersion: '1.0.0',",
            "        updatedVersion: '1.1.0',",
            "        rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1',",
            "        rollbackStatus: 'NOT_TRIGGERED',",
            "        updateReportPath: 'garda-agent-orchestrator/runtime/update-reports/update-1.md'",
            '    };',
            '};'
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'update-messages.json'),
        JSON.stringify({
            messages: [
                {
                    version: '1.1.0',
                    title: 'Major registry note',
                    body: ['Re-check new workflow affordances.']
                }
            ]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(bundleRoot, 'CHANGELOG.md'),
        [
            '# Changelog',
            '',
            '## Unreleased',
            '- pending',
            '',
            '## 1.1.0',
            '- added versioned notes',
            '',
            '## 1.0.0',
            '- initial release'
        ].join('\n'),
        'utf8'
    );

    return {
        workspaceRoot,
        bundleUpdateModulePath,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    };
}

function captureConsoleLogs(callback: () => Promise<void>): Promise<string[]> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(args.map((entry) => String(entry)).join(' '));
    };

    return callback()
        .then(() => lines)
        .finally(() => {
            console.log = originalLog;
        });
}

test('handleUpdate surfaces update messages and release notes in plain text and json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.equal(plainTextLines.includes('PreviousVersion: 1.0.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('UpdateMessages:'), true);
            assert.equal(plainTextLines.includes('- 1.1.0: Major registry note'), true);
            assert.equal(plainTextLines.includes('ReleaseNotes:'), true);
            assert.equal(plainTextLines.includes('  - added versioned notes'), true);
            assert.equal(require.cache[fixture.bundleUpdateModulePath], undefined);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.previousVersion, '1.0.0');
            assert.equal(parsed.updatedVersion, '1.1.0');
            assert.equal(parsed.updateMessages[0].title, 'Major registry note');
            assert.equal(parsed.releaseNotes[0].version, '1.1.0');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate --apply includes UpdateApplied in plain text and enriches announcements after apply', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.equal(plainTextLines.includes('UpdateApplied: True'), true);
            assert.equal(plainTextLines.includes('PreviousVersion: 1.0.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('UpdateMessages:'), true);
            assert.equal(plainTextLines.includes('ReleaseNotes:'), true);
            assert.equal(require.cache[fixture.bundleUpdateModulePath], undefined);
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});
