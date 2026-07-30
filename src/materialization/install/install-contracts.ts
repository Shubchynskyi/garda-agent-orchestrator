import type {
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../common';

export interface RunInstallOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    preserveExisting?: boolean;
    alignExisting?: boolean;
    runInit?: boolean;
    answerDependentOnly?: boolean;
    skipBackups?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
    lifecycleLockAlreadyHeld?: boolean;
    initRunner?: (options: {
        targetRoot: string;
        assistantLanguage: string;
        assistantBrevity: string;
        sourceOfTruth: string;
        enforceNoAutoCommit: boolean;
        claudeOrchestratorFullAccess: boolean;
        tokenEconomyEnabled: boolean;
        providerMinimalism: boolean;
        activeAgentFilesSeed: string | null;
        preserveLegacyReviewExecutionPolicyOmission: boolean;
    }) => Record<string, unknown> | void;
}

export type BackupFileCallback = (destPath: string, relativePath: string) => void;

export type ProviderOrchestratorProfile =
    ReturnType<typeof getProviderOrchestratorProfileDefinitions>[number];

export type GitHubSkillBridgeProfile =
    ReturnType<typeof getGitHubSkillBridgeProfileDefinitions>[number];

export interface InstallStageMetrics {
    deployed: number;
    backedUp: number;
    skippedExisting: number;
    aligned: number;
    forcedOverwrites: number;
}

export interface InstallFilesystemStage {
    metrics: InstallStageMetrics;
    writeBackupManifest(timestamp: string): void;
    backupFile: BackupFileCallback;
    syncManagedBlockOnDisk(
        destPath: string,
        relativePath: string,
        managedBlock: string
    ): boolean;
    syncTaskFileOnDisk(
        destPath: string,
        relativePath: string,
        templateContent: string
    ): boolean;
    removeManagedBlockOrFileOnDisk(destPath: string, relativePath: string): boolean;
    applyEntrypointManagedBlock(relativePath: string, managedBlock: string): void;
    getTemplateContent(sourcePath: string, relativePath: string): string | null;
    writeTextFile(filePath: string, content: string): void;
}
