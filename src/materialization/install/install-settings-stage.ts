import * as path from 'node:path';
import { ensureDirectory, pathExists, readTextFile } from '../../core/filesystem';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import {
    buildClaudeLocalSettingsContent,
    buildGitignoreEntries,
    buildQwenSettingsContent,
    buildVscodeSettingsContent,
    syncManagedAgentignoreActiveBlockInContent,
    syncManagedGitignoreBlockInContent
} from '../content-builders';
import type {
    InstallFilesystemStage,
    ProviderOrchestratorProfile
} from './install-contracts';

export interface RunInstallEditorSettingsStageOptions {
    targetRoot: string;
    dryRun: boolean;
    preserveExisting: boolean;
    canonicalEntryFile: string;
    enableClaudeOrchestratorFullAccess: boolean;
    filesystem: InstallFilesystemStage;
}

export interface InstallEditorSettingsStageResult {
    qwenExists: boolean;
    qwenSettingsParseMode: string;
    qwenSettingsNeedsUpdate: boolean;
    qwenSettingsUpdated: boolean;
    claudeLocalSettingsParseMode: string;
    claudeLocalSettingsNeedsUpdate: boolean;
    claudeLocalSettingsUpdated: boolean;
    vscodeSettingsUpdated: boolean;
}

export function runInstallEditorSettingsStage(
    options: RunInstallEditorSettingsStageOptions
): InstallEditorSettingsStageResult {
    const {
        targetRoot,
        dryRun,
        preserveExisting,
        canonicalEntryFile,
        enableClaudeOrchestratorFullAccess,
        filesystem
    } = options;
    const { metrics } = filesystem;

    const qwenRelativePath = '.qwen/settings.json';
    const qwenPath = path.join(targetRoot, qwenRelativePath);
    const qwenExists = pathExists(qwenPath);
    const qwenExisting = qwenExists ? readTextFile(qwenPath) : null;
    const qwenPlan = qwenExists
        ? buildQwenSettingsContent(qwenExisting, [
            TASK_QUEUE_FILENAME,
            canonicalEntryFile
        ])
        : { content: null, needsUpdate: false, parseMode: 'not-present' };
    let qwenUpdated = false;

    if (qwenExists && (!preserveExisting || qwenPlan.needsUpdate)) {
        filesystem.backupFile(qwenPath, qwenRelativePath);
        if (!dryRun) {
            ensureDirectory(path.dirname(qwenPath));
            if (qwenPlan.content !== null) {
                filesystem.writeTextFile(qwenPath, qwenPlan.content);
            }
        }
        qwenUpdated = true;
        if (preserveExisting) metrics.aligned++;
        else metrics.deployed++;
    }

    const claudeRelativePath = '.claude/settings.local.json';
    const claudePath = path.join(targetRoot, claudeRelativePath);
    const claudeExisting = pathExists(claudePath) ? readTextFile(claudePath) : null;
    const claudePlan = buildClaudeLocalSettingsContent(
        claudeExisting,
        enableClaudeOrchestratorFullAccess
    );
    let claudeUpdated = false;
    let claudeParseMode: string = claudePlan.parseMode;
    let claudeNeedsUpdate = claudePlan.needsUpdate;

    if (enableClaudeOrchestratorFullAccess) {
        if (pathExists(claudePath)) {
            if (!preserveExisting || claudePlan.needsUpdate) {
                filesystem.backupFile(claudePath, claudeRelativePath);
                if (!dryRun) {
                    ensureDirectory(path.dirname(claudePath));
                    filesystem.writeTextFile(claudePath, claudePlan.content);
                }
                claudeUpdated = true;
                if (preserveExisting) metrics.aligned++;
                else metrics.deployed++;
            }
        } else {
            if (!dryRun) {
                ensureDirectory(path.dirname(claudePath));
                filesystem.writeTextFile(claudePath, claudePlan.content);
            }
            claudeUpdated = true;
            metrics.deployed++;
        }
    } else {
        claudeParseMode = 'disabled_by_init_answer';
        claudeNeedsUpdate = false;
    }

    const vscodeRelativePath = '.vscode/settings.json';
    const vscodePath = path.join(targetRoot, vscodeRelativePath);
    const vscodeExisting = pathExists(vscodePath) ? readTextFile(vscodePath) : null;
    const vscodePlan = buildVscodeSettingsContent(vscodeExisting);
    let vscodeSettingsUpdated = false;

    if (vscodePlan.needsUpdate) {
        if (pathExists(vscodePath)) {
            filesystem.backupFile(vscodePath, vscodeRelativePath);
        }
        if (!dryRun) {
            ensureDirectory(path.dirname(vscodePath));
            filesystem.writeTextFile(vscodePath, vscodePlan.content);
        }
        vscodeSettingsUpdated = true;
        if (pathExists(vscodePath) && preserveExisting) metrics.aligned++;
        else metrics.deployed++;
    }

    return {
        qwenExists,
        qwenSettingsParseMode: qwenPlan.parseMode,
        qwenSettingsNeedsUpdate: qwenPlan.needsUpdate,
        qwenSettingsUpdated: qwenUpdated,
        claudeLocalSettingsParseMode: claudeParseMode,
        claudeLocalSettingsNeedsUpdate: claudeNeedsUpdate,
        claudeLocalSettingsUpdated: claudeUpdated,
        vscodeSettingsUpdated
    };
}

export interface RunInstallIgnoreStageOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun: boolean;
    activeEntryFiles: readonly string[];
    providerOrchestratorProfiles: readonly ProviderOrchestratorProfile[];
    enableClaudeOrchestratorFullAccess: boolean;
    providerMinimalism: boolean;
    qwenExists: boolean;
    filesystem: InstallFilesystemStage;
}

export interface InstallIgnoreStageResult {
    gitignoreEntriesAdded: number;
    agentignoreUpdated: boolean;
}

export function runInstallIgnoreStage(
    options: RunInstallIgnoreStageOptions
): InstallIgnoreStageResult {
    const {
        targetRoot,
        bundleRoot,
        dryRun,
        activeEntryFiles,
        providerOrchestratorProfiles,
        enableClaudeOrchestratorFullAccess,
        providerMinimalism,
        qwenExists,
        filesystem
    } = options;
    const gitignoreEntryList = buildGitignoreEntries(
        [...activeEntryFiles],
        [...providerOrchestratorProfiles],
        enableClaudeOrchestratorFullAccess,
        qwenExists,
        providerMinimalism
    );
    const gitignorePath = path.join(targetRoot, '.gitignore');
    const agentignorePath = path.join(targetRoot, '.agentignore');

    if (dryRun) {
        const existingGitignoreContent = pathExists(gitignorePath)
            ? readTextFile(gitignorePath)
            : '';
        const gitignoreEntriesAdded = syncManagedGitignoreBlockInContent(
            existingGitignoreContent,
            gitignoreEntryList,
            enableClaudeOrchestratorFullAccess
        ).addedEntries;
        const existingAgentignoreContent = pathExists(agentignorePath)
            ? readTextFile(agentignorePath)
            : '';
        const agentignoreUpdated = syncManagedAgentignoreActiveBlockInContent(
            existingAgentignoreContent,
            path.basename(bundleRoot)
        ).changed;
        return { gitignoreEntriesAdded, agentignoreUpdated };
    }

    const gitignoreExisted = pathExists(gitignorePath);
    const existingGitignoreContent = gitignoreExisted
        ? readTextFile(gitignorePath)
        : '';
    const gitignoreSync = syncManagedGitignoreBlockInContent(
        existingGitignoreContent,
        gitignoreEntryList,
        enableClaudeOrchestratorFullAccess
    );
    if (gitignoreSync.changed) {
        if (gitignoreExisted) {
            filesystem.backupFile(gitignorePath, '.gitignore');
        }
        filesystem.writeTextFile(gitignorePath, gitignoreSync.content);
    }

    const agentignoreExisted = pathExists(agentignorePath);
    const existingAgentignoreContent = agentignoreExisted
        ? readTextFile(agentignorePath)
        : '';
    const agentignoreSync = syncManagedAgentignoreActiveBlockInContent(
        existingAgentignoreContent,
        path.basename(bundleRoot)
    );
    if (agentignoreSync.changed) {
        if (agentignoreExisted) {
            filesystem.backupFile(agentignorePath, '.agentignore');
        }
        filesystem.writeTextFile(agentignorePath, agentignoreSync.content);
    }

    return {
        gitignoreEntriesAdded: gitignoreSync.addedEntries,
        agentignoreUpdated: agentignoreSync.changed
    };
}
