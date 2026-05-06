import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { runUpdate } from '../../../src/lifecycle/update';
import {
    findSnapshotByVersion,
    runRollback,
    runRollbackToVersion
} from '../../../src/lifecycle/rollback';
import { removePathRecursive } from '../../../src/lifecycle/common';

const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';

type CapturedMaterializationOptions = {
    claudeOrchestratorFullAccess?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
};

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

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function seedExecutableBundleSurface(repoRoot: string, bundleRoot: string) {
    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundleRoot, 'bin'));
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
}

function setupUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(bundle, 'package.json'));
    seedExecutableBundleSurface(repoRoot, bundle);
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

function injectBundleUpdate(bundleRoot: string, updateMarker: string, nextVersion: string) {
    const versionPath = path.join(bundleRoot, 'VERSION');
    const canonicalRuleIndexPath = path.join(bundleRoot, 'template', 'entrypoints', 'canonical-rule-index.md');
    const currentTemplate = fs.readFileSync(canonicalRuleIndexPath, 'utf8');
    const updatedTemplate = currentTemplate.replace(
        MANAGED_END,
        `Rollback marker: ${updateMarker}\r\n${MANAGED_END}`
    );

    fs.writeFileSync(versionPath, `${nextVersion}\n`, 'utf8');
    fs.writeFileSync(canonicalRuleIndexPath, updatedTemplate, 'utf8');
}


describe('runRollback (snapshot mode)', () => {
    const repoRoot = findRepoRoot();

    it('restores the previous deployed version from the latest rollback snapshot', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const baselineVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            const canonicalRuleIndexPath = path.join(bundleRoot, 'template', 'entrypoints', 'canonical-rule-index.md');
            const baselineCanonicalRuleIndex = fs.readFileSync(canonicalRuleIndexPath, 'utf8');

            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            injectBundleUpdate(sourceBundleRoot, 'ROLLBACK_TEST_MARKER', '9.9.9');

            const updateResult = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(updateResult.checkUpdateResult, 'UPDATED');
            assert.ok(fs.existsSync(updateResult.syncBackupMetadataPath));
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');
            assert.match(fs.readFileSync(canonicalRuleIndexPath, 'utf8'), /ROLLBACK_TEST_MARKER/);

            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot
            });

            assert.equal(rollbackResult.rollbackMode, 'snapshot');
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');
            assert.equal(rollbackResult.rollbackVersion, baselineVersion);
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), baselineVersion);
            assert.equal(fs.readFileSync(canonicalRuleIndexPath, 'utf8'), baselineCanonicalRuleIndex);
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');
            assert.ok(fs.existsSync(path.join(projectRoot, rollbackResult.rollbackReportPath)));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves project-memory user content across snapshot rollback', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Initial materialization
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Add user content to project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nB2B logistics SaaS.\n', 'utf8');

            const baselineVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();

            // Update to newer version (creates rollback snapshot that includes project-memory)
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            injectBundleUpdate(sourceBundleRoot, 'ROLLBACK_PM_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');

            // Rollback to previous version
            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot
            });

            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');
            assert.equal(rollbackResult.rollbackVersion, baselineVersion);

            // project-memory user content must survive rollback
            const restoredPmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            assert.ok(fs.existsSync(restoredPmDir),
                'project-memory dir must exist after rollback');
            assert.ok(fs.existsSync(path.join(restoredPmDir, 'context.md')),
                'context.md must survive rollback');
            assert.ok(
                fs.readFileSync(path.join(restoredPmDir, 'context.md'), 'utf8')
                    .includes('B2B logistics SaaS'),
                'user content must be intact after rollback'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('fails clearly for legacy snapshots without rollback metadata', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-legacy-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const snapshotRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks', 'update-20260325-010203');
        fs.mkdirSync(snapshotRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        try {
            await assert.rejects(
                runRollback({
                    targetRoot: workspaceRoot,
                    bundleRoot
                }),
                /Rollback snapshot metadata is missing/
            );
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });
});


describe('runRollback (version mode)', () => {
    const repoRoot = findRepoRoot();

    it('rolls back to a specific version via sourcePath', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Run initial update so the workspace is materialized
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Create "older version" source
            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            injectBundleUpdate(olderSource, 'OLDER_VERSION_MARKER', '1.0.0');

            // Now update to a "newer" version
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_VERSION_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');

            // Rollback to version 1.0.0 via sourcePath
            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot,
                targetVersion: '1.0.0',
                sourcePath: olderSource,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(rollbackResult.rollbackMode, 'version');
            assert.equal((rollbackResult as Record<string, unknown>).targetVersion, '1.0.0');
            assert.equal((rollbackResult as Record<string, unknown>).sourceType, 'path');
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');
            assert.equal((rollbackResult as Record<string, unknown>).syncStatus, 'SUCCESS');
            assert.equal((rollbackResult as Record<string, unknown>).installStatus, 'PASS');
            assert.equal((rollbackResult as Record<string, unknown>).materializationStatus, 'PASS');
            assert.equal(rollbackResult.rollbackVersion, '1.0.0');
            assert.equal(rollbackResult.updatedVersion, '1.0.0');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '1.0.0');
            assert.ok(rollbackResult.safetySnapshotCreated);
            assert.ok(fs.existsSync(path.join(projectRoot, rollbackResult.rollbackReportPath)));

            // Verify the report mentions version mode
            const reportContent = fs.readFileSync(
                path.join(projectRoot, rollbackResult.rollbackReportPath), 'utf8'
            );
            assert.match(reportContent, /RollbackMode: version/);
            assert.match(reportContent, /RequestedVersion: 1\.0\.0/);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('finds and uses a matching rollback snapshot when the requested version exists in snapshots', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Initial materialization
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const baselineVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();

            // Update to newer version (creates a rollback snapshot with baselineVersion)
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');

            // findSnapshotByVersion should locate the snapshot created before the update
            const snapshot = findSnapshotByVersion(projectRoot, baselineVersion);
            assert.ok(snapshot, 'Expected to find a snapshot matching the baseline version');

            // Rollback to baselineVersion — should use the snapshot source
            const rollbackResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot,
                targetVersion: baselineVersion,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(rollbackResult.rollbackMode, 'version');
            assert.equal((rollbackResult as Record<string, unknown>).sourceType, 'snapshot');
            assert.equal(rollbackResult.restoreStatus, 'SUCCESS');
            assert.equal(rollbackResult.rollbackVersion, baselineVersion);
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), baselineVersion);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects rollback to the current version', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const currentVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();

            // Create a source at the same version
            const sameVersionSource = path.join(projectRoot, 'same-version-source');
            copyDirRecursive(bundleRoot, sameVersionSource);

            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot,
                    targetVersion: currentVersion,
                    sourcePath: sameVersionSource,
                    initAnswersPath: answersPath
                }),
                /already at the requested target version/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects when source version does not match targetVersion', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Create a source with version 3.0.0 but request rollback to 2.0.0
            const mismatchSource = path.join(projectRoot, 'mismatch-source');
            copyDirRecursive(bundleRoot, mismatchSource);
            fs.writeFileSync(path.join(mismatchSource, 'VERSION'), '3.0.0\n', 'utf8');

            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot,
                    targetVersion: '2.0.0',
                    sourcePath: mismatchSource,
                    initAnswersPath: answersPath
                }),
                /does not match requested target version/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('performs dry-run without changing files', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Update to newer version
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');

            // Create older source
            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '1.0.0\n', 'utf8');

            const dryResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot,
                targetVersion: '1.0.0',
                sourcePath: olderSource,
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.equal(dryResult.rollbackMode, 'version');
            assert.equal(dryResult.restoreStatus, 'SKIPPED_DRY_RUN');
            assert.equal((dryResult as Record<string, unknown>).syncStatus, 'SKIPPED_DRY_RUN');
            assert.equal((dryResult as Record<string, unknown>).installStatus, 'SKIPPED_DRY_RUN');
            assert.equal(dryResult.safetySnapshotCreated, false);
            // VERSION should be unchanged
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '9.9.9');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('performs safety rollback when install fails during version rollback', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Update to newer version
            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const preRollbackVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            assert.equal(preRollbackVersion, '9.9.9');

            // Create source for 1.0.0
            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '1.0.0\n', 'utf8');

            // Inject a failing installRunner
            await assert.rejects(
                runRollback({
                    targetRoot: projectRoot,
                    bundleRoot,
                    targetVersion: '1.0.0',
                    sourcePath: olderSource,
                    initAnswersPath: answersPath,
                    installRunner: () => { throw new Error('INJECTED_INSTALL_FAILURE'); }
                }),
                /safety rollback completed successfully.*INJECTED_INSTALL_FAILURE/
            );

            // Safety rollback should have restored original state
            // VERSION may be from safety snapshot (9.9.9 was the pre-rollback state)
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                preRollbackVersion
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects when init answers are missing for version rollback', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rollback-noanswers-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '2.0.0\n', 'utf8');
        try {
            await assert.rejects(
                runRollback({
                    targetRoot: workspaceRoot,
                    bundleRoot,
                    targetVersion: '1.0.0',
                    initAnswersPath: 'nonexistent/answers.json'
                }),
                /Init answers artifact not found/
            );
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });
});


describe('findSnapshotByVersion', () => {
    it('returns null when no snapshots exist', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-find-snap-'));
        try {
            const result = findSnapshotByVersion(workspaceRoot, '1.0.0');
            assert.equal(result, null);
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });

    it('returns null when no snapshot matches the requested version', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-find-snap-'));
        const snapshotDir = path.join(
            workspaceRoot, 'garda-agent-orchestrator', 'runtime',
            'update-rollbacks', 'update-20260401-120000'
        );
        const bundleInSnapshot = path.join(snapshotDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleInSnapshot, { recursive: true });
        fs.writeFileSync(path.join(bundleInSnapshot, 'VERSION'), '2.0.0\n', 'utf8');
        fs.writeFileSync(
            path.join(snapshotDir, 'rollback-records.json'),
            JSON.stringify([{ relativePath: 'test.txt', existed: true, pathType: 'file' }]),
            'utf8'
        );
        try {
            const result = findSnapshotByVersion(workspaceRoot, '1.0.0');
            assert.equal(result, null);
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });

    it('finds a snapshot matching the requested version', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-find-snap-'));
        const snapshotDir = path.join(
            workspaceRoot, 'garda-agent-orchestrator', 'runtime',
            'update-rollbacks', 'update-20260401-120000'
        );
        const bundleInSnapshot = path.join(snapshotDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleInSnapshot, { recursive: true });
        fs.writeFileSync(path.join(bundleInSnapshot, 'VERSION'), '1.5.0\n', 'utf8');
        fs.writeFileSync(
            path.join(snapshotDir, 'rollback-records.json'),
            JSON.stringify([{ relativePath: 'test.txt', existed: true, pathType: 'file' }]),
            'utf8'
        );
        try {
            const result = findSnapshotByVersion(workspaceRoot, '1.5.0');
            assert.ok(result);
            assert.ok(result.includes('update-20260401-120000'));
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });

    it('ignores snapshots without rollback records', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-find-snap-'));
        const snapshotDir = path.join(
            workspaceRoot, 'garda-agent-orchestrator', 'runtime',
            'update-rollbacks', 'update-20260401-120000'
        );
        const bundleInSnapshot = path.join(snapshotDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleInSnapshot, { recursive: true });
        fs.writeFileSync(path.join(bundleInSnapshot, 'VERSION'), '1.5.0\n', 'utf8');
        // No rollback-records.json
        try {
            const result = findSnapshotByVersion(workspaceRoot, '1.5.0');
            assert.equal(result, null);
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });
});


describe('rollback ownership boundaries', () => {
    it('rejects snapshot path that escapes target root via absolute path', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rb-boundary-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        try {
            const outsidePath = path.resolve(workspaceRoot, '..', 'evil-snapshot');
            await assert.rejects(
                runRollback({
                    targetRoot: workspaceRoot,
                    bundleRoot,
                    snapshotPath: outsidePath
                }),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });

    it('rejects snapshot path that escapes target root via relative traversal', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rb-boundary-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        try {
            await assert.rejects(
                runRollback({
                    targetRoot: workspaceRoot,
                    bundleRoot,
                    snapshotPath: '../escape'
                }),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });

    it('rejects init answers path outside target root in version rollback', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rb-boundary-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '2.0.0\n', 'utf8');
        try {
            const outsideAnswers = path.resolve(workspaceRoot, '..', 'evil-answers.json');
            await assert.rejects(
                runRollback({
                    targetRoot: workspaceRoot,
                    bundleRoot,
                    targetVersion: '1.0.0',
                    initAnswersPath: outsideAnswers
                }),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(workspaceRoot);
        }
    });
});


describe('rollback dry-run preview', () => {
    const repoRoot = findRepoRoot();

    it('version rollback dry-run returns previewAffectedItems', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '1.0.0\n', 'utf8');

            const dryResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot,
                targetVersion: '1.0.0',
                sourcePath: olderSource,
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.equal(dryResult.dryRun, true);
            const preview = (dryResult as Record<string, unknown>).previewAffectedItems as string[];
            assert.ok(Array.isArray(preview), 'previewAffectedItems must be an array');
            assert.ok(preview.length > 0, 'previewAffectedItems must not be empty in dry-run');
            assert.ok(preview.some(item => item.includes('VERSION')), 'preview must include VERSION');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('snapshot rollback dry-run returns previewAffectedItems from records', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const dryResult = await runRollback({
                targetRoot: projectRoot,
                bundleRoot,
                dryRun: true
            });

            assert.equal(dryResult.rollbackMode, 'snapshot');
            assert.equal(dryResult.dryRun, true);
            const preview = (dryResult as Record<string, unknown>).previewAffectedItems as string[];
            assert.ok(Array.isArray(preview), 'previewAffectedItems must be an array');
            assert.ok(preview.length > 0, 'snapshot preview must list affected paths');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('non-dry-run rollback returns empty previewAffectedItems', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const newerSource = path.join(projectRoot, 'newer-source');
            copyDirRecursive(bundleRoot, newerSource);
            injectBundleUpdate(newerSource, 'NEWER_MARKER', '9.9.9');

            await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: newerSource,
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (runnerOptions) => runUpdate({
                    targetRoot: runnerOptions.targetRoot,
                    bundleRoot,
                    initAnswersPath: runnerOptions.initAnswersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                })
            });

            const result = await runRollback({
                targetRoot: projectRoot,
                bundleRoot
            });

            const preview = (result as Record<string, unknown>).previewAffectedItems as string[];
            assert.ok(Array.isArray(preview), 'previewAffectedItems must be an array');
            assert.equal(preview.length, 0, 'non-dry-run must return empty preview');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

describe('rollback materialization plumbing', () => {
    const repoRoot = findRepoRoot();

    it('passes gitignore-scoping init fields to the rollback materialization runner', async () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'true',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            }, null, 2), 'utf8');
            const olderSource = path.join(projectRoot, 'older-source');
            copyDirRecursive(bundleRoot, olderSource);
            fs.writeFileSync(path.join(olderSource, 'VERSION'), '0.9.0\n', 'utf8');
            let captured: CapturedMaterializationOptions | undefined;
            let capturedCalled = false;

            const result = await runRollbackToVersion({
                targetRoot: projectRoot,
                bundleRoot,
                targetVersion: '0.9.0',
                sourcePath: olderSource,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true,
                materializationRunner: (options) => {
                    captured = options;
                    capturedCalled = true;
                }
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(capturedCalled, true, 'materializationRunner should receive rollback-provided init options');
            const capturedOptions = captured!;
            assert.equal(capturedOptions.claudeOrchestratorFullAccess, true);
            assert.equal(capturedOptions.providerMinimalism, false);
            assert.equal(capturedOptions.activeAgentFilesSeed, 'CLAUDE.md, AGENTS.md');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});
