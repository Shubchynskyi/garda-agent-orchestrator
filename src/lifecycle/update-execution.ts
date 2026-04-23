import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists } from '../core/fs';
import { readJsonFile } from '../core/json';
import { runInstall } from '../materialization/install';
import { runInit } from '../materialization/init';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { getExpectedBundleInvariantPaths, validateBundleInvariants } from '../validators/workspace-layout';
import {
    buildRefreshAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../runtime/agent-init-state';
import { getActiveAgentEntrypointFiles } from '../materialization/common';
import { cleanupStaleTaskEventLocks } from '../gate-runtime/task-events';
import { restoreRollbackSnapshot } from './common';
import { getLiveVersionPayload, type ResolvedUpdateSources } from './update-source';

export interface InstallRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    runInit?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface MaterializationRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean;
    claudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    activeAgentFilesSeed: string | null;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface VerifyRunnerOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

export interface ManifestRunnerOptions {
    targetRoot: string;
}

export interface ContractMigrationResult {
    appliedCount?: number;
    appliedFiles?: string[];
}

interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

export interface UpdatePipelineRunners {
    installRunner?: ((options: InstallRunnerOptions) => void) | null;
    materializationRunner?: ((options: MaterializationRunnerOptions) => void) | null;
    verifyRunner?: ((options: VerifyRunnerOptions) => unknown) | null;
    manifestRunner?: ((options: ManifestRunnerOptions) => unknown) | null;
    contractMigrationRunner?: ((options: { rootPath: string }) => ContractMigrationResult) | null;
}

export interface UpdatePipelineStageResult {
    installStatus: string;
    materializationStatus: string;
    contractMigrationStatus: string;
    contractMigrationCount: number;
    contractMigrationFiles: string[];
    verifyStatus: string;
    manifestStatus: string;
    invariantStatus: string;
    updatedVersion: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Executes the update pipeline stages (install, materialization, contract
 * migrations, verify, manifest validation, invariant check, agent-init-state
 * sync) and returns per-stage status. On failure, attempts rollback if a
 * snapshot exists and re-throws.
 */
export function executeUpdatePipelineStages(options: {
    normalizedTarget: string;
    bundleRoot: string;
    dryRun: boolean;
    skipVerify: boolean;
    skipManifestValidation: boolean;
    lifecycleLockAlreadyHeld: boolean;
    sources: ResolvedUpdateSources;
    runners: UpdatePipelineRunners;
    rollbackSnapshotCreated: boolean;
    rollbackSnapshotPath: string;
    rollbackRecords: RollbackRecord[];
}): UpdatePipelineStageResult & { rollbackStatus: string } {
    const {
        normalizedTarget,
        bundleRoot,
        dryRun,
        skipVerify,
        skipManifestValidation,
        lifecycleLockAlreadyHeld,
        sources,
        runners,
        rollbackSnapshotCreated,
        rollbackSnapshotPath,
        rollbackRecords
    } = options;

    const {
        installRunner = null,
        materializationRunner = null,
        verifyRunner = null,
        manifestRunner = null,
        contractMigrationRunner = null
    } = runners;

    let installStatus = 'NOT_RUN';
    let materializationStatus = 'NOT_RUN';
    let contractMigrationStatus = 'NOT_RUN';
    let verifyStatus = 'NOT_RUN';
    let manifestStatus = 'NOT_RUN';
    let invariantStatus = 'NOT_RUN';
    let updatedVersion = sources.bundleVersion;
    let contractMigrationCount = 0;
    let contractMigrationFiles: string[] = [];
    let rollbackStatus = 'NOT_NEEDED';

    const expectedInvariantPaths = getExpectedBundleInvariantPaths(bundleRoot);
    let currentStage = 'INSTALL';

    try {
        currentStage = 'INSTALL';
        if (installRunner) {
            installRunner({
                targetRoot: normalizedTarget,
                bundleRoot,
                dryRun,
                assistantLanguage: sources.assistantLanguage,
                assistantBrevity: sources.assistantBrevity,
                sourceOfTruth: sources.sourceOfTruth,
                initAnswersPath: sources.initAnswersResolvedPath,
                lifecycleLockAlreadyHeld
            });
        } else {
            runInstall({
                targetRoot: normalizedTarget,
                bundleRoot,
                runInit: false,
                dryRun,
                assistantLanguage: sources.assistantLanguage,
                assistantBrevity: sources.assistantBrevity,
                sourceOfTruth: sources.sourceOfTruth,
                initAnswersPath: sources.initAnswersResolvedPath,
                lifecycleLockAlreadyHeld
            });
        }
        installStatus = 'PASS';

        if (dryRun) {
            materializationStatus = 'SKIPPED_DRY_RUN';
            contractMigrationStatus = 'SKIPPED_DRY_RUN';
            verifyStatus = 'SKIPPED_DRY_RUN';
            manifestStatus = 'SKIPPED_DRY_RUN';
        } else {
            currentStage = 'MATERIALIZATION';
            if (materializationRunner) {
                materializationRunner({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    assistantLanguage: sources.assistantLanguage,
                    assistantBrevity: sources.assistantBrevity,
                    sourceOfTruth: sources.sourceOfTruth,
                    enforceNoAutoCommit: sources.enforceNoAutoCommit,
                    claudeOrchestratorFullAccess: sources.claudeOrchestratorFullAccess,
                    tokenEconomyEnabled: sources.tokenEconomyEnabled,
                    providerMinimalism: sources.providerMinimalism,
                    activeAgentFilesSeed: sources.activeAgentFilesSeed,
                    lifecycleLockAlreadyHeld
                });
            } else {
                runInit({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    dryRun: false,
                    assistantLanguage: sources.assistantLanguage,
                    assistantBrevity: sources.assistantBrevity,
                    sourceOfTruth: sources.sourceOfTruth,
                    enforceNoAutoCommit: sources.enforceNoAutoCommit,
                    claudeOrchestratorFullAccess: sources.claudeOrchestratorFullAccess,
                    tokenEconomyEnabled: sources.tokenEconomyEnabled,
                    providerMinimalism: sources.providerMinimalism,
                    activeAgentFilesSeed: sources.activeAgentFilesSeed,
                    lifecycleLockAlreadyHeld
                });
            }
            materializationStatus = 'PASS';

            currentStage = 'CONTRACT_MIGRATIONS';
            if (contractMigrationRunner) {
                const migResult = contractMigrationRunner({ rootPath: normalizedTarget });
                contractMigrationCount = migResult.appliedCount || 0;
                contractMigrationFiles = migResult.appliedFiles || [];
                contractMigrationStatus = 'PASS';
            } else {
                contractMigrationStatus = 'SKIPPED_NO_RUNNER';
            }

            currentStage = 'VERIFY';
            if (skipVerify) {
                verifyStatus = 'SKIPPED';
            } else if (verifyRunner) {
                verifyRunner({
                    targetRoot: normalizedTarget,
                    sourceOfTruth: sources.sourceOfTruth,
                    initAnswersPath: sources.initAnswersResolvedPath
                });
                verifyStatus = 'PASS';
            } else {
                verifyStatus = 'SKIPPED_NO_RUNNER';
            }

            currentStage = 'MANIFEST_VALIDATION';
            if (skipManifestValidation) {
                manifestStatus = 'SKIPPED';
            } else if (manifestRunner) {
                manifestRunner({ targetRoot: normalizedTarget });
                manifestStatus = 'PASS';
            } else {
                manifestStatus = 'SKIPPED_NO_RUNNER';
            }

            currentStage = 'INVARIANT_CHECK';
            const invariantResult = validateBundleInvariants(
                path.join(normalizedTarget, resolveBundleName()),
                expectedInvariantPaths
            );
            if (!invariantResult.isValid) {
                throw new Error(`Bundle invariant violation after update: ${invariantResult.violations.join('; ')}`);
            }
            invariantStatus = 'PASS';
            writeProtectedControlPlaneManifest(normalizedTarget);

            const previousAgentInitStateResult = readAgentInitStateSafe(normalizedTarget);
            const previousAgentInitState = previousAgentInitStateResult.state;
            const activeEntryFiles = getActiveAgentEntrypointFiles(
                sources.activeAgentFilesSeed,
                sources.sourceOfTruth
            );

            const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {
                AssistantLanguage: sources.assistantLanguage,
                SourceOfTruth: sources.sourceOfTruth,
                ActiveAgentFiles: activeEntryFiles
            });

            try {
                cleanupStaleTaskEventLocks(
                    path.join(normalizedTarget, resolveBundleName()),
                    { dryRun: false }
                );
            } catch (lockError: unknown) {
                contractMigrationFiles.push(`Warning: Lock cleanup failed: ${getErrorMessage(lockError)}`);
            }

            writeAgentInitState(normalizedTarget, buildRefreshAgentInitState({
                previousState: previousAgentInitState,
                preserveExistingCheckpoints,
                assistantLanguage: sources.assistantLanguage,
                sourceOfTruth: sources.sourceOfTruth,
                orchestratorVersion: sources.bundleVersion,
                activeAgentFiles: activeEntryFiles,
                verificationPassed: skipVerify ? null : true,
                manifestValidationPassed: skipManifestValidation ? null : true,
                autoConfirmPrompts: true,
                autoAcceptRules: true
            }));

            if (pathExists(sources.liveVersionPath)) {
                try {
                    const newLiveVersion = getLiveVersionPayload(readJsonFile(sources.liveVersionPath));
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
                throw new Error(
                    `Update failed during ${currentStage}. Original error: ${errorMessage}. Rollback failed: ${rollbackMsg}`
                );
            }
            throw new Error(
                `Update failed during ${currentStage} and rollback completed successfully. Original error: ${errorMessage}`
            );
        }
        throw new Error(`Update failed during ${currentStage}. Error: ${errorMessage}`);
    }

    if (!dryRun && rollbackSnapshotCreated && rollbackStatus === 'NOT_NEEDED') {
        rollbackStatus = 'NOT_TRIGGERED';
    }

    return {
        installStatus,
        materializationStatus,
        contractMigrationStatus,
        contractMigrationCount,
        contractMigrationFiles,
        verifyStatus,
        manifestStatus,
        invariantStatus,
        updatedVersion,
        rollbackStatus
    };
}
