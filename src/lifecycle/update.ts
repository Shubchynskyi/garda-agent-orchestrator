import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES, resolveBundleName } from '../core/constants';
import { getProviderBridgeDirectoryPaths } from '../core/provider-registry';
import {
    createRollbackSnapshot,
    getTimestamp,
    getRollbackRecordsPath,
    withLifecycleOperationLock,
    validateTargetRoot,
    writeRollbackRecords
} from './common';
import { resolveUpdateSources } from './update-source';
import {
    executeUpdatePipelineStages,
    type InstallRunnerOptions,
    type MaterializationRunnerOptions,
    type VerifyRunnerOptions,
    type ManifestRunnerOptions,
    type ContractMigrationResult
} from './update-execution';
import { collectUpdateAnnouncements } from './update-announcements';
import { writeUpdateReport, buildUpdateResult } from './update-reporting';

interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

interface UpdateTrustContext {
    policy: string;
    overrideUsed: boolean;
    overrideSource: string;
    sourceType: string;
    sourceReference: string;
}

interface RunUpdateOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    dryRun?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    installRunner?: ((options: InstallRunnerOptions) => void) | null;
    materializationRunner?: ((options: MaterializationRunnerOptions) => void) | null;
    verifyRunner?: ((options: VerifyRunnerOptions) => unknown) | null;
    manifestRunner?: ((options: ManifestRunnerOptions) => unknown) | null;
    contractMigrationRunner?: ((options: { rootPath: string }) => ContractMigrationResult) | null;
    trustContext?: UpdateTrustContext | null;
}

export function getUpdateRollbackItems(rootPath: string, initAnswersResolvedPath: string): string[] {
    const items = [
        ...ALL_AGENT_ENTRYPOINT_FILES,
        'TASK.md',
        '.claude/settings.local.json',
        '.qwen/settings.json',
        ...getProviderBridgeDirectoryPaths(),
        '.gitignore',
        '.git/hooks/pre-commit',
        resolveBundleName() + '/.gitattributes',
        resolveBundleName() + '/bin',
        resolveBundleName() + '/dist',
        resolveBundleName() + '/live',
        resolveBundleName() + '/live/docs/project-memory',
        resolveBundleName() + '/package.json',
        resolveBundleName() + '/src',
        resolveBundleName() + '/template',
        resolveBundleName() + '/README.md',
        resolveBundleName() + '/HOW_TO.md',
        resolveBundleName() + '/MANIFEST.md',
        resolveBundleName() + '/AGENT_INIT_PROMPT.md',
        resolveBundleName() + '/CHANGELOG.md',
        resolveBundleName() + '/LICENSE',
        resolveBundleName() + '/VERSION'
    ];

    const rootResolved = path.resolve(rootPath);
    const answersResolved = path.resolve(initAnswersResolvedPath);
    const rel = path.relative(rootResolved, answersResolved).replace(/\\/g, '/');
    items.push(rel);

    return [...new Set(items)].sort();
}

export function runUpdate(options: RunUpdateOptions) {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        installRunner = null,
        materializationRunner = null,
        verifyRunner = null,
        manifestRunner = null,
        contractMigrationRunner = null,
        trustContext = null
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    return withLifecycleOperationLock(normalizedTarget, 'update', () => {

    const sources = resolveUpdateSources(normalizedTarget, initAnswersPath, bundleRoot);
    const timestamp = getTimestamp();
    const rollbackSnapshotRelativePath = `${resolveBundleName()}/runtime/update-rollbacks/update-${timestamp}`;
    const rollbackSnapshotPath = path.join(normalizedTarget, rollbackSnapshotRelativePath);
    const rollbackRecordsRelativePath = `${rollbackSnapshotRelativePath}/${path.basename(getRollbackRecordsPath(rollbackSnapshotPath))}`;
    const updateReportRelativePath = `${resolveBundleName()}/runtime/update-reports/update-${timestamp}.md`;
    const updateReportPath = path.join(normalizedTarget, updateReportRelativePath);

    let rollbackSnapshotCreated = false;
    let rollbackRecordCount = 0;
    let rollbackRecords: RollbackRecord[] = [];

    const effectiveTrustContext: UpdateTrustContext = trustContext || {
        policy: 'unknown',
        overrideUsed: false,
        overrideSource: 'none',
        sourceType: 'unknown',
        sourceReference: 'unknown'
    };

    if (!dryRun) {
        fs.mkdirSync(path.dirname(rollbackSnapshotPath), { recursive: true });
        const rollbackItems = getUpdateRollbackItems(normalizedTarget, sources.initAnswersResolvedPath);
        rollbackRecords = createRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackItems) as RollbackRecord[];
        writeRollbackRecords(rollbackSnapshotPath, rollbackRecords);
        rollbackRecordCount = rollbackRecords.length;
        rollbackSnapshotCreated = true;
    }

    const stageResult = executeUpdatePipelineStages({
        normalizedTarget,
        bundleRoot,
        dryRun,
        skipVerify,
        skipManifestValidation,
        sources,
        runners: {
            installRunner,
            materializationRunner,
            verifyRunner,
            manifestRunner,
            contractMigrationRunner
        },
        rollbackSnapshotCreated,
        rollbackSnapshotPath,
        rollbackRecords
    });
    const announcements = !dryRun
        ? collectUpdateAnnouncements(bundleRoot, sources.previousVersion, stageResult.updatedVersion)
        : {
            updateMessages: [],
            releaseNotes: [],
            warnings: []
        };

    if (!dryRun) {
        writeUpdateReport(updateReportPath, {
            normalizedTarget,
            initAnswersResolvedPath: sources.initAnswersResolvedPath,
            rollbackSnapshotRelativePath,
            rollbackRecordsRelativePath,
            rollbackRecordCount,
            rollbackStatus: stageResult.rollbackStatus,
            trustContext: effectiveTrustContext,
            previousVersion: sources.previousVersion,
            previousVersionSource: sources.previousVersionSource,
            bundleVersion: sources.bundleVersion,
            stageResult,
            announcements
        });
    }

    return buildUpdateResult({
        normalizedTarget,
        sources,
        trustContext: effectiveTrustContext,
        rollbackSnapshotRelativePath,
        rollbackRecordsRelativePath,
        rollbackSnapshotCreated,
        rollbackRecordCount,
        stageResult,
        dryRun,
        updateReportRelativePath,
        announcements
    });
    });
}
