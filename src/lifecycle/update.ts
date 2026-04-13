import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import { readJsonFile } from '../core/json';
import { isPathInsideRoot } from '../core/paths';
import { validateInitAnswers } from '../schemas/init-answers';
import { runInstall } from '../materialization/install';
import { runInit } from '../materialization/init';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { getExpectedBundleInvariantPaths, validateBundleInvariants } from '../validators/workspace-layout';
import {
    buildRefreshAgentInitState,
    createAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../runtime/agent-init-state';
import { getActiveAgentEntrypointFiles } from '../materialization/common';
import { cleanupStaleTaskEventLocks } from '../gate-runtime/task-events';
import {
    createRollbackSnapshot,
    getTimestamp,
    getRollbackRecordsPath,
    restoreRollbackSnapshot,
    withLifecycleOperationLock,
    validateTargetRoot,
    writeRollbackRecords
} from './common';

interface LiveVersionPayload {
    Version?: unknown;
}

interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

interface InstallRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    runInit?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface MaterializationRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean;
    tokenEconomyEnabled: boolean;
}

interface VerifyRunnerOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface ManifestRunnerOptions {
    targetRoot: string;
}

interface ContractMigrationResult {
    appliedCount?: number;
    appliedFiles?: string[];
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

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getLiveVersionPayload(value: unknown): LiveVersionPayload {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as LiveVersionPayload
        : {};
}

/**
 * Computes the list of relative paths that should be included in an update rollback.
 * Returns the rollback item set for the Node update lifecycle.
 */
export function getUpdateRollbackItems(rootPath: string, initAnswersResolvedPath: string): string[] {
    const items = [
        'CLAUDE.md',
        'AGENTS.md',
        'GEMINI.md',
        'TASK.md',
        '.claude/settings.local.json',
        '.qwen/settings.json',
        '.github/copilot-instructions.md',
        '.github/agents',
        '.windsurf/rules/rules.md',
        '.windsurf/agents',
        '.junie/guidelines.md',
        '.junie/agents',
        '.antigravity/rules.md',
        '.antigravity/agents',
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

    // Add the init answers file as a relative path
    const rootResolved = path.resolve(rootPath);
    const answersResolved = path.resolve(initAnswersResolvedPath);
    const rel = path.relative(rootResolved, answersResolved).replace(/\\/g, '/');
    items.push(rel);

    return [...new Set(items)].sort();
}

/**
 * Runs the update pipeline.
 * Node implementation of the update lifecycle.
 *
 * @param {object} options
 * @param {string} options.targetRoot - Project root directory
 * @param {string} options.bundleRoot - Orchestrator bundle directory (source of scripts/template)
 * @param {string} [options.initAnswersPath]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.skipVerify=false]
 * @param {boolean} [options.skipManifestValidation=false]
 * @param {Function} [options.installRunner] - Optional override for install step
 * @param {Function} [options.materializationRunner] - Optional override for live/ materialization step
 * @param {Function} [options.verifyRunner] - Optional override for verify step
 * @param {Function} [options.manifestRunner] - Optional override for manifest validation step
 * @param {Function} [options.contractMigrationRunner] - Optional override for contract migration step
 * @returns {object} Update result
 */
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
    // Resolve init answers path
    let initAnswersResolvedPath;
    if (path.isAbsolute(initAnswersPath)) {
        initAnswersResolvedPath = initAnswersPath;
    } else {
        initAnswersResolvedPath = path.resolve(normalizedTarget, initAnswersPath);
    }

    if (!isPathInsideRoot(normalizedTarget, initAnswersResolvedPath)) {
        throw new Error(`InitAnswersPath must resolve inside target root '${normalizedTarget}'.`);
    }
    if (!pathExists(initAnswersResolvedPath)) {
        throw new Error(`Init answers artifact not found: ${initAnswersResolvedPath}`);
    }

    const initAnswersRaw = readTextFile(initAnswersResolvedPath);
    if (!initAnswersRaw.trim()) {
        throw new Error(`Init answers artifact is empty: ${initAnswersResolvedPath}`);
    }

    let initAnswers;
    try {
        initAnswers = JSON.parse(initAnswersRaw);
    } catch (_e) {
        throw new Error(`Init answers artifact is not valid JSON: ${initAnswersResolvedPath}`);
    }

    // Detect previous version from live/version.json
    const liveVersionPath = path.join(normalizedTarget, resolveBundleName(), 'live', 'version.json');
    let existingLiveVersion: LiveVersionPayload | null = null;
    let previousVersion = 'unknown';
    let previousVersionSource = 'missing';
    if (pathExists(liveVersionPath)) {
        try {
            existingLiveVersion = getLiveVersionPayload(readJsonFile(liveVersionPath));
            const parsedVersion = existingLiveVersion && existingLiveVersion.Version
                ? String(existingLiveVersion.Version).trim()
                : null;
            if (parsedVersion) {
                previousVersion = parsedVersion;
                previousVersionSource = 'live/version.json';
            } else {
                previousVersionSource = existingLiveVersion && existingLiveVersion.Version !== undefined
                    ? 'live/version.json-empty'
                    : 'live/version.json-no-version-field';
            }
        } catch (_e) {
            previousVersionSource = 'live/version.json-invalid-json';
        }
    }

    // Read bundle version
    const bundleVersionPath = path.join(bundleRoot, 'VERSION');
    if (!pathExists(bundleVersionPath)) {
        throw new Error(`Bundle version file not found: ${bundleVersionPath}`);
    }
    const bundleVersion = readTextFile(bundleVersionPath).trim();
    if (!bundleVersion) {
        throw new Error(`Bundle version file is empty: ${bundleVersionPath}`);
    }

    // Validate required init answer fields
    const validated = validateInitAnswers(initAnswers);
    const assistantLanguage = validated.AssistantLanguage;
    const assistantBrevity = validated.AssistantBrevity;
    const sourceOfTruth = validated.SourceOfTruth;

    const timestamp = getTimestamp();
    const rollbackSnapshotRelativePath = `${resolveBundleName()}/runtime/update-rollbacks/update-${timestamp}`;
    const rollbackSnapshotPath = path.join(normalizedTarget, rollbackSnapshotRelativePath);
    const rollbackRecordsRelativePath = `${rollbackSnapshotRelativePath}/${path.basename(getRollbackRecordsPath(rollbackSnapshotPath))}`;
    const updateReportRelativePath = `${resolveBundleName()}/runtime/update-reports/update-${timestamp}.md`;
    const updateReportPath = path.join(normalizedTarget, updateReportRelativePath);

    let rollbackSnapshotCreated = false;
    let rollbackRecordCount = 0;
    let rollbackStatus = 'NOT_NEEDED';
    let rollbackRecords: RollbackRecord[] = [];

    let installStatus = 'NOT_RUN';
    let materializationStatus = 'NOT_RUN';
    let contractMigrationStatus = 'NOT_RUN';
    let verifyStatus = 'NOT_RUN';
    let manifestStatus = 'NOT_RUN';
    let invariantStatus = 'NOT_RUN';
    let updatedVersion = bundleVersion;
    let contractMigrationCount = 0;
    let contractMigrationFiles: string[] = [];
    const expectedInvariantPaths = getExpectedBundleInvariantPaths(bundleRoot);
    const effectiveTrustContext: UpdateTrustContext = trustContext || {
        policy: 'unknown',
        overrideUsed: false,
        overrideSource: 'none',
        sourceType: 'unknown',
        sourceReference: 'unknown'
    };

    // Create rollback snapshot (not in dry-run)
    if (!dryRun) {
        fs.mkdirSync(path.dirname(rollbackSnapshotPath), { recursive: true });
        const rollbackItems = getUpdateRollbackItems(normalizedTarget, initAnswersResolvedPath);
        rollbackRecords = createRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackItems) as RollbackRecord[];
        writeRollbackRecords(rollbackSnapshotPath, rollbackRecords);
        rollbackRecordCount = rollbackRecords.length;
        rollbackSnapshotCreated = true;
    }

    let currentStage = 'INSTALL';
    try {
        // Install step
        currentStage = 'INSTALL';
        if (installRunner) {
            installRunner({
                targetRoot: normalizedTarget,
                bundleRoot,
                dryRun,
                assistantLanguage,
                assistantBrevity,
                sourceOfTruth,
                initAnswersPath: initAnswersResolvedPath
            });
        } else {
            runInstall({
                targetRoot: normalizedTarget,
                bundleRoot,
                runInit: false,
                dryRun,
                assistantLanguage,
                assistantBrevity,
                sourceOfTruth,
                initAnswersPath: initAnswersResolvedPath
            });
        }
        installStatus = 'PASS';

        if (dryRun) {
            materializationStatus = 'SKIPPED_DRY_RUN';
            contractMigrationStatus = 'SKIPPED_DRY_RUN';
            verifyStatus = 'SKIPPED_DRY_RUN';
            manifestStatus = 'SKIPPED_DRY_RUN';
        } else {
            // Materialization - rematerialize live/ from updated templates
            currentStage = 'MATERIALIZATION';
            if (materializationRunner) {
                materializationRunner({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    assistantLanguage,
                    assistantBrevity,
                    sourceOfTruth,
                    enforceNoAutoCommit: validated.EnforceNoAutoCommit,
                    tokenEconomyEnabled: validated.TokenEconomyEnabled
                });
            } else {
                runInit({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    dryRun: false,
                    assistantLanguage,
                    assistantBrevity,
                    sourceOfTruth,
                    enforceNoAutoCommit: validated.EnforceNoAutoCommit,
                    tokenEconomyEnabled: validated.TokenEconomyEnabled
                });
            }
            materializationStatus = 'PASS';

            // Contract migrations
            currentStage = 'CONTRACT_MIGRATIONS';
            if (contractMigrationRunner) {
                const migResult = contractMigrationRunner({ rootPath: normalizedTarget });
                contractMigrationCount = migResult.appliedCount || 0;
                contractMigrationFiles = migResult.appliedFiles || [];
                contractMigrationStatus = 'PASS';
            } else {
                contractMigrationStatus = 'SKIPPED_NO_RUNNER';
            }

            // Verify
            currentStage = 'VERIFY';
            if (skipVerify) {
                verifyStatus = 'SKIPPED';
            } else if (verifyRunner) {
                verifyRunner({
                    targetRoot: normalizedTarget,
                    sourceOfTruth,
                    initAnswersPath: initAnswersResolvedPath
                });
                verifyStatus = 'PASS';
            } else {
                verifyStatus = 'SKIPPED_NO_RUNNER';
            }

            // Manifest validation
            currentStage = 'MANIFEST_VALIDATION';
            if (skipManifestValidation) {
                manifestStatus = 'SKIPPED';
            } else if (manifestRunner) {
                manifestRunner({ targetRoot: normalizedTarget });
                manifestStatus = 'PASS';
            } else {
                manifestStatus = 'SKIPPED_NO_RUNNER';
            }

            // Bundle invariant check (enforce consistency).
            currentStage = 'INVARIANT_CHECK';
            const invariantResult = validateBundleInvariants(path.join(normalizedTarget, resolveBundleName()), expectedInvariantPaths);
            if (!invariantResult.isValid) {
                throw new Error(`Bundle invariant violation after update: ${invariantResult.violations.join('; ')}`);
            }
            invariantStatus = 'PASS';
            writeProtectedControlPlaneManifest(normalizedTarget);

            // Sync agent init state after successful update
            const previousAgentInitStateResult = readAgentInitStateSafe(normalizedTarget);
            const previousAgentInitState = previousAgentInitStateResult.state;
            const activeEntryFilesSeed = initAnswers.ActiveAgentFiles
                ? (Array.isArray(initAnswers.ActiveAgentFiles) ? initAnswers.ActiveAgentFiles.join(', ') : String(initAnswers.ActiveAgentFiles))
                : null;
            const activeEntryFiles = getActiveAgentEntrypointFiles(activeEntryFilesSeed, sourceOfTruth);

            const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {
                AssistantLanguage: assistantLanguage,
                SourceOfTruth: sourceOfTruth,
                ActiveAgentFiles: activeEntryFiles
            });

            // Automatic stale lock cleanup during update.
            try {
                cleanupStaleTaskEventLocks(path.join(normalizedTarget, resolveBundleName()), { dryRun: false });
            } catch (lockError: unknown) {
                // Log and continue
                contractMigrationFiles.push(`Warning: Lock cleanup failed: ${getErrorMessage(lockError)}`);
            }

            writeAgentInitState(normalizedTarget, buildRefreshAgentInitState({
                previousState: previousAgentInitState,
                preserveExistingCheckpoints,
                assistantLanguage,
                sourceOfTruth,
                orchestratorVersion: bundleVersion,
                activeAgentFiles: activeEntryFiles,
                verificationPassed: skipVerify ? null : true,
                manifestValidationPassed: skipManifestValidation ? null : true,
                autoConfirmPrompts: true,
                autoAcceptRules: true
            }));

            // Re-read updated version
            if (pathExists(liveVersionPath)) {
                try {
                    const newLiveVersion = getLiveVersionPayload(readJsonFile(liveVersionPath));
                    if (newLiveVersion && newLiveVersion.Version) {
                        const newParsed = String(newLiveVersion.Version).trim();
                        if (newParsed) updatedVersion = newParsed;
                    }
                } catch (_e) {
                    updatedVersion = 'unknown';
                }
            }
        }
    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);

        switch (currentStage) {
            case 'INSTALL': installStatus = 'FAIL'; break;
            case 'BUNDLE_SYNC': installStatus = 'FAIL'; break;
            case 'MATERIALIZATION': materializationStatus = 'FAIL'; break;
            case 'CONTRACT_MIGRATIONS': contractMigrationStatus = 'FAIL'; break;
            case 'VERIFY': verifyStatus = 'FAIL'; break;
            case 'MANIFEST_VALIDATION': manifestStatus = 'FAIL'; break;
            case 'INVARIANT_CHECK': invariantStatus = 'FAIL'; break;
        }

        if (!dryRun && rollbackSnapshotCreated) {
            try {
                restoreRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackRecords);
                rollbackStatus = 'SUCCESS';
            } catch (rollbackError: unknown) {
                const rollbackMsg = getErrorMessage(rollbackError);
                rollbackStatus = `FAILED: ${rollbackMsg}`;
                throw new Error(`Update failed during ${currentStage}. Original error: ${errorMessage}. Rollback failed: ${rollbackMsg}`);
            }
            throw new Error(`Update failed during ${currentStage} and rollback completed successfully. Original error: ${errorMessage}`);
        }
        throw new Error(`Update failed during ${currentStage}. Error: ${errorMessage}`);
    }

    if (!dryRun && rollbackSnapshotCreated && rollbackStatus === 'NOT_NEEDED') {
        rollbackStatus = 'NOT_TRIGGERED';
    }

    // Generate update report
    if (!dryRun) {
        fs.mkdirSync(path.dirname(updateReportPath), { recursive: true });
        const reportLines = [
            '# Update Report',
            '',
            `GeneratedAt: ${new Date().toISOString()}`,
            `TargetRoot: ${normalizedTarget}`,
            `InitAnswersPath: ${initAnswersResolvedPath}`,
            `RollbackSnapshotPath: ${rollbackSnapshotRelativePath}`,
            `RollbackRecordsPath: ${rollbackRecordsRelativePath}`,
            `RollbackSnapshotRecordCount: ${rollbackRecordCount}`,
            `RollbackStatus: ${rollbackStatus}`,
            '',
            '## Trust',
            `SourceType: ${effectiveTrustContext.sourceType}`,
            `SourceReference: ${effectiveTrustContext.sourceReference}`,
            `TrustPolicy: ${effectiveTrustContext.policy}`,
            `TrustOverrideUsed: ${effectiveTrustContext.overrideUsed ? 'yes' : 'no'}`,
            `TrustOverrideSource: ${effectiveTrustContext.overrideSource}`,
            '',
            '## Version',
            `PreviousVersion: ${previousVersion}`,
            `PreviousVersionSource: ${previousVersionSource}`,
            `BundleVersion: ${bundleVersion}`,
            `UpdatedVersion: ${updatedVersion}`,
            '',
            '## CommandStatus',
            `Install: ${installStatus}`,
            `Materialization: ${materializationStatus}`,
            `ContractMigrations: ${contractMigrationStatus}`,
            `Verify: ${verifyStatus}`,
            `ManifestValidation: ${manifestStatus}`,
            `InvariantCheck: ${invariantStatus}`,
            '',
            '## ContractMigrations',
            `AppliedCount: ${contractMigrationCount}`,
            contractMigrationFiles.length > 0
                ? `AppliedFiles: ${contractMigrationFiles.join(', ')}`
                : 'AppliedFiles: none'
        ];
        fs.writeFileSync(updateReportPath, reportLines.join('\r\n'), 'utf8');
    }

    return {
        targetRoot: normalizedTarget,
        initAnswersPath: initAnswersResolvedPath,
        rollbackSnapshotPath: rollbackSnapshotRelativePath,
        rollbackRecordsPath: dryRun ? 'not-generated-in-dry-run' : rollbackRecordsRelativePath,
        rollbackSnapshotCreated,
        rollbackRecordCount,
        rollbackStatus,
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth,
        trustPolicy: effectiveTrustContext.policy,
        trustOverrideUsed: effectiveTrustContext.overrideUsed,
        trustOverrideSource: effectiveTrustContext.overrideSource,
        previousVersion,
        previousVersionSource,
        bundleVersion,
        updatedVersion,
        installStatus,
        materializationStatus,
        contractMigrationStatus,
        contractMigrationCount,
        contractMigrationFiles,
        verifyStatus,
        manifestValidationStatus: manifestStatus,
        updateReportPath: dryRun ? 'not-generated-in-dry-run' : updateReportRelativePath
    };
    });
}
