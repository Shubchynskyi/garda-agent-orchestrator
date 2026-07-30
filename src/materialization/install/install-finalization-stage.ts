import * as path from 'node:path';
import { ensureDirectory } from '../../core/filesystem';
import { writeJsonFile } from '../../core/json';
import { writeProtectedControlPlaneManifest } from '../../gates/shared/helpers';
import { convertActiveAgentEntrypointFilesToString } from '../common';
import { runSwitchMode } from '../switch-mode';
import type { RunInstallOptions } from './install-contracts';

export interface RunInstallFinalizationStageOptions {
    targetRoot: string;
    normalizedTarget: string;
    liveVersionPath: string;
    dryRun: boolean;
    switchModeBeforeInstall: string | null;
    bundleVersion: string;
    resolvedInitPath: string;
    sourceOfTruth: string;
    canonicalEntryFile: string;
    activeEntryFiles: readonly string[];
    assistantLanguage: string;
    assistantBrevity: string;
    enforceNoAutoCommit: boolean;
    enableClaudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    runInit: boolean;
    initRunner: RunInstallOptions['initRunner'];
    activeEntryFilesSeed: string | null;
    preserveLegacyReviewExecutionPolicyOmission: boolean;
}

export interface InstallFinalizationStageResult {
    initInvoked: boolean;
    initResult: Record<string, unknown> | null;
    liveVersionWritten: boolean;
    protectedControlPlaneManifestWritten: boolean;
}

export function runInstallFinalizationStage(
    options: RunInstallFinalizationStageOptions
): InstallFinalizationStageResult {
    const {
        targetRoot,
        normalizedTarget,
        liveVersionPath,
        dryRun,
        switchModeBeforeInstall,
        bundleVersion,
        resolvedInitPath,
        sourceOfTruth,
        canonicalEntryFile,
        activeEntryFiles,
        assistantLanguage,
        assistantBrevity,
        enforceNoAutoCommit,
        enableClaudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism,
        runInit,
        initRunner,
        activeEntryFilesSeed,
        preserveLegacyReviewExecutionPolicyOmission
    } = options;
    let initInvoked = false;
    let initResult: Record<string, unknown> | null = null;

    if (runInit && !dryRun && initRunner) {
        const maybeInitResult = initRunner({
            targetRoot,
            assistantLanguage,
            assistantBrevity,
            sourceOfTruth,
            enforceNoAutoCommit,
            claudeOrchestratorFullAccess: enableClaudeOrchestratorFullAccess,
            tokenEconomyEnabled,
            providerMinimalism,
            activeAgentFilesSeed: activeEntryFilesSeed,
            preserveLegacyReviewExecutionPolicyOmission
        });
        initResult = (
            maybeInitResult
            && typeof maybeInitResult === 'object'
            && !Array.isArray(maybeInitResult)
        )
            ? maybeInitResult
            : null;
        initInvoked = true;
    }

    let liveVersionWritten = false;
    let protectedControlPlaneManifestWritten = false;
    if (!dryRun) {
        if (switchModeBeforeInstall === 'off') {
            runSwitchMode({
                targetRoot,
                mode: 'off',
                dryRun: false
            });
        }
        ensureDirectory(path.dirname(liveVersionPath));
        writeJsonFile(liveVersionPath, {
            Version: bundleVersion,
            UpdatedAt: new Date().toISOString(),
            SourceOfTruth: sourceOfTruth,
            CanonicalEntrypoint: canonicalEntryFile,
            ActiveAgentFiles: convertActiveAgentEntrypointFilesToString(
                [...activeEntryFiles]
            ),
            AssistantLanguage: assistantLanguage,
            AssistantBrevity: assistantBrevity,
            EnforceNoAutoCommit: enforceNoAutoCommit,
            ClaudeOrchestratorFullAccess: enableClaudeOrchestratorFullAccess,
            TokenEconomyEnabled: tokenEconomyEnabled,
            ProviderMinimalism: providerMinimalism,
            InitAnswersPath: resolvedInitPath
        });
        liveVersionWritten = true;
        writeProtectedControlPlaneManifest(normalizedTarget);
        protectedControlPlaneManifestWritten = true;
    }

    return {
        initInvoked,
        initResult,
        liveVersionWritten,
        protectedControlPlaneManifestWritten
    };
}
