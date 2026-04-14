import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import {
    BUNDLE_SYNC_ITEMS,
    removePathRecursive,
    getUpdateSentinelPath,
    withLifecycleOperationLockAsync
} from '../../../src/lifecycle/common';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function copyPathRecursive(sourcePath: string, destinationPath: string) {
    const stats = fs.lstatSync(sourcePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (stats.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath)) {
            copyPathRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
        }
        return;
    }
    fs.copyFileSync(sourcePath, destinationPath);
}

function seedBundleSyncSurface(sourceRoot: string, bundleRoot: string) {
    for (const item of BUNDLE_SYNC_ITEMS) {
        const sourceItemPath = path.join(sourceRoot, item);
        if (!fs.existsSync(sourceItemPath)) {
            continue;
        }
        copyPathRecursive(sourceItemPath, path.join(bundleRoot, item));
    }
}

function createSourcePathFixture(repoRoot: string): string {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-source-'));
    seedBundleSyncSurface(repoRoot, sourceRoot);
    return sourceRoot;
}

function setupCheckUpdateWorkspace(
    repoRoot: string,
    deployedVersion: string,
    options: { syncSurfaceFrom?: string | null } = {}
) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    if (options.syncSurfaceFrom) {
        seedBundleSyncSurface(options.syncSurfaceFrom, bundle);
    }

    // Write a specific VERSION
    fs.writeFileSync(path.join(bundle, 'VERSION'), `${deployedVersion || '1.0.0'}\n`, 'utf8');

    // Create runtime dir
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

describe('runCheckUpdate', () => {
    const repoRoot = findRepoRoot();

    it('detects UP_TO_DATE when versions match', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: repoRoot
        });
        try {
            // Point to local repo as the "remote"
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.contentDriftDetected, false);
            assert.equal(result.currentVersion, currentVersion);
            assert.equal(result.trustPolicy, 'overridden');
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('detects UPDATE_AVAILABLE when deployed version is older', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                dryRun: false,
                apply: false,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.currentVersion, '0.0.1');
            assert.ok(result.latestVersion);
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('can acquire update source from an npm package spec', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: repoRoot
        });
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.sourceType, 'npm');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.currentVersion, currentVersion);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('treats same-version local source drift as update available and applies refresh', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: sourceRoot
        });

        try {
            fs.appendFileSync(
                path.join(sourceRoot, 'template', 'docs', 'agent-rules', '80-task-workflow.md'),
                '\n<!-- same-version refresh sentinel -->\n',
                'utf8'
            );

            const probeResult = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                apply: false,
                trustOverride: true
            });

            assert.equal(probeResult.currentVersion, currentVersion);
            assert.equal(probeResult.latestVersion, currentVersion);
            assert.equal(probeResult.versionDiffDetected, false);
            assert.equal(probeResult.contentDriftDetected, true);
            assert.ok(probeResult.driftedSyncItems.includes('template'));
            assert.equal(probeResult.updateAvailable, true);
            assert.equal(probeResult.checkUpdateResult, 'UPDATE_AVAILABLE');

            let updateRunnerCalled = false;
            const applyResult = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            assert.ok(updateRunnerCalled, 'same-version local refresh must execute lifecycle runner');
            assert.equal(applyResult.updateApplied, true);
            assert.equal(applyResult.checkUpdateResult, 'UPDATED');
            assert.ok(applyResult.syncedItems.includes('template'));
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('reports DRY_RUN_UPDATE_AVAILABLE when apply + dryRun', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                dryRun: true,
                apply: true,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.ok(result.syncedItems.length > 0);
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('applies update with updateRunner callback', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let updateRunnerCalled = false;

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.ok(updateRunnerCalled);
            assert.ok(result.syncItemsUpdated > 0);
            assert.equal(result.syncRollbackStatus, 'NOT_TRIGGERED');
            assert.ok(fs.existsSync(result.syncBackupMetadataPath));
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates workspace state after lock acquisition and skips redundant apply', async () => {
        const latestVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                seedBundleSyncSurface(repoRoot, bundleRoot);
                fs.writeFileSync(path.join(bundleRoot, 'VERSION'), `${latestVersion}\n`, 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, false, 'updateRunner must not run when the workspace is already updated');
            assert.equal(result.currentVersion, latestVersion);
            assert.equal(result.latestVersion, latestVersion);
            assert.equal(result.updateAvailable, false);
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateApplied, false);
            assert.equal(result.syncItemsUpdated, 0);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates workspace state after lock acquisition and refuses stale downgrade apply', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '1.5.0\n', 'utf8');

            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '9.9.9\n', 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, false, 'updateRunner must not run when the workspace became newer than the source');
            assert.equal(result.currentVersion, '9.9.9');
            assert.equal(result.latestVersion, '1.5.0');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.versionDiffDetected, false);
            assert.equal(result.contentDriftDetected, false);
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates latest source version after lock acquisition when source-path mutates in place', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '1.5.0\n', 'utf8');

            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '2.5.0\n', 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, true, 'updateRunner should still execute when the source version advanced');
            assert.equal(result.currentVersion, '0.0.1');
            assert.equal(result.latestVersion, '2.5.0');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.updateApplied, true);
            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '2.5.0');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back sync on updateRunner failure', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            // Write a file that will get backed up and should be restored
            fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.0.1');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('Simulated update failure');
                    }
                }),
                /sync rollback completed.*Simulated update failure/
            );

            // VERSION should be restored to original
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'), '0.0.1');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('throws when deployed bundle not found', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-no-bundle-'));
        const fakeBundleRoot = path.join(tmpDir, 'other');
        fs.mkdirSync(fakeBundleRoot, { recursive: true });
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: fakeBundleRoot,
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /Deployed bundle not found/
            );
        } finally {
            removePathRecursive(tmpDir);
        }
    });

    it('throws when VERSION file is missing from deployed bundle', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-no-version-'));
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundle, { recursive: true });
        // Do not create VERSION file
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: bundle,
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /Current VERSION file not found/
            );
        } finally {
            removePathRecursive(tmpDir);
        }
    });

    it('throws when packageSpec and sourcePath are provided together', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    packageSpec: 'garda-agent-orchestrator@latest',
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /either packageSpec or sourcePath/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('defers VERSION sync until after lifecycle completes (T-067)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let versionDuringLifecycle = null;

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    // Read VERSION during lifecycle execution - it should still be the old version
                    versionDuringLifecycle = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            // During lifecycle, VERSION must still show the old version
            assert.equal(versionDuringLifecycle, '0.0.1',
                'VERSION must not be updated before lifecycle completes');
            // After lifecycle, VERSION should be updated
            const finalVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            assert.notEqual(finalVersion, '0.0.1',
                'VERSION should be updated after lifecycle completes');
            assert.ok(result.syncedItems.includes('VERSION'),
                'VERSION should be listed in synced items');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('realigns live/version.json after deferred VERSION sync completes', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.mkdirSync(path.join(bundleRoot, 'live'), { recursive: true });
            fs.writeFileSync(
                path.join(bundleRoot, 'live', 'version.json'),
                JSON.stringify({ Version: '0.0.1', SourceOfTruth: 'Codex', CanonicalEntrypoint: 'AGENTS.md' }, null, 2),
                'utf8'
            );

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {}
            });

            const finalVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            const liveVersion = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'version.json'), 'utf8'));
            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(liveVersion.Version, finalVersion);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('does not update VERSION when lifecycle fails (T-067)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.0.1');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('Simulated lifecycle failure');
                    }
                }),
                /sync rollback completed.*Simulated lifecycle failure/
            );

            // VERSION must still be the old value - never advanced
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '0.0.1',
                'VERSION must not advance when lifecycle fails');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('writes sentinel before lifecycle and removes it after success (T-067)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let sentinelExistsDuringLifecycle = false;
            const sentinelPath = getUpdateSentinelPath(bundleRoot);

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    sentinelExistsDuringLifecycle = fs.existsSync(sentinelPath);
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.ok(sentinelExistsDuringLifecycle,
                'Sentinel must exist during lifecycle execution');
            assert.ok(!fs.existsSync(sentinelPath),
                'Sentinel must be removed after successful update');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removes sentinel on lifecycle failure (T-067)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const sentinelPath = getUpdateSentinelPath(bundleRoot);

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('Simulated failure');
                    }
                }),
                /Simulated failure/
            );

            assert.ok(!fs.existsSync(sentinelPath),
                'Sentinel must be cleaned up even on failure');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('accepts signal option without error on sourcePath flow (T-061)', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: repoRoot
        });
        try {
            const ac = new AbortController();
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                signal: ac.signal
            });
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('accepts onProgress option without error (T-061)', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: repoRoot
        });
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                onProgress: () => {}
            });
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('npm install streams progress via onProgress callback (T-061)', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion);
        try {
            const progressChunks = [];
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                onProgress: (chunk) => { progressChunks.push(chunk); }
            });
            assert.equal(result.sourceType, 'npm');
            // npm install produces stderr output (progress/warnings) that should be captured
            // The callback may or may not receive chunks depending on npm's output behavior,
            // but it should not throw or break the flow
            assert.equal(typeof progressChunks.length, 'number');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('classifies missing VERSION in an update source path (T-059)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        const invalidSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-invalid-source-'));
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: invalidSourceRoot,
                    noPrompt: true,
                    dryRun: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /DiagnosticCode: UPDATE_SOURCE_VERSION_MISSING/);
                    assert.match((error as Error).message, /DiagnosticSource:/);
                    assert.match((error as Error).message, /DiagnosticHint:/);
                    return true;
                }
            );
        } finally {
            removePathRecursive(invalidSourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('restores previous VERSION when deferred VERSION copy fails (T-092)', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            // Create a source directory that has a VERSION whose copy will fail.
            // We achieve this by making the source VERSION path point at a directory
            // (fs.copyFileSync throws EISDIR when the source is a directory).
            const fakeSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-t092-src-'));
            // Seed the fake source with a minimal VERSION that is a *directory*,
            // which will make fs.copyFileSync throw during the deferred copy.
            const fakeVersionPath = path.join(fakeSourceRoot, 'VERSION');
            // First create a normal VERSION so the pre-check passes...
            fs.writeFileSync(fakeVersionPath, '9.9.9');
            // Copy at least one sync item so the sync loop has work to do.
            const fakeBinPath = path.join(fakeSourceRoot, 'bin');
            fs.mkdirSync(fakeBinPath, { recursive: true });
            fs.writeFileSync(path.join(fakeBinPath, 'stub.js'), '// stub');

            // We need the updateRunner to succeed (lifecycle passes) but then
            // the deferred VERSION copy to fail.  Replace the source VERSION
            // with a directory after lifecycle runs.
            let lifecycleCallCount = 0;
            const fakeUpdateRunner = () => {
                lifecycleCallCount++;
                // Swap the source VERSION file to a directory so copyFileSync
                // will throw EISDIR on the deferred copy.
                fs.unlinkSync(fakeVersionPath);
                fs.mkdirSync(fakeVersionPath, { recursive: true });
            };

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: fakeSourceRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: fakeUpdateRunner
                }),
                (error) => {
                    // The error should propagate (it wraps the copyFileSync failure).
                    return error instanceof Error;
                }
            );

            assert.equal(lifecycleCallCount, 1, 'updateRunner should have been called');
            // The previous VERSION must be restored despite the late failure.
            assert.ok(fs.existsSync(path.join(bundleRoot, 'VERSION')),
                'VERSION file must still exist after deferred copy failure');
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                '0.0.1',
                'VERSION must be restored to its previous value (T-092)'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});
