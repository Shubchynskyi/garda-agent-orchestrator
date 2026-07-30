import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES } from '../../core/constants';
import { pathExists, readTextFile } from '../../core/filesystem';
import {
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../common';
import {
    MANAGED_END,
    MANAGED_START,
    buildCanonicalManagedBlock,
    buildGitHubSkillBridgeAgentContent,
    buildProviderOrchestratorAgentContent,
    buildRedirectManagedBlock,
    buildSharedStartTaskWorkflowContent
} from '../content-builders';
import type {
    GitHubSkillBridgeProfile,
    InstallFilesystemStage,
    ProviderOrchestratorProfile
} from './install-contracts';

export interface RunInstallPrimaryEntrypointStageOptions {
    sourceRoot: string;
    canonicalEntryFile: string;
    redirectEntryFiles: readonly string[];
    providerBridgePaths: readonly string[];
    filesystem: InstallFilesystemStage;
}

export function runInstallPrimaryEntrypointStage(
    options: RunInstallPrimaryEntrypointStageOptions
): void {
    const {
        sourceRoot,
        canonicalEntryFile,
        redirectEntryFiles,
        providerBridgePaths,
        filesystem
    } = options;
    const managedEntrypointTemplateContent = readTextFile(
        path.join(sourceRoot, 'entrypoints', 'canonical-rule-index.md')
    );
    const canonicalBlock = buildCanonicalManagedBlock(
        canonicalEntryFile,
        managedEntrypointTemplateContent
    );
    filesystem.applyEntrypointManagedBlock(canonicalEntryFile, canonicalBlock);

    for (const redirectFile of redirectEntryFiles) {
        const redirectBlock = buildRedirectManagedBlock(
            redirectFile,
            canonicalEntryFile,
            [...providerBridgePaths]
        );
        filesystem.applyEntrypointManagedBlock(redirectFile, redirectBlock);
    }
}

export interface RunInstallProviderEntrypointStageOptions {
    targetRoot: string;
    canonicalEntryFile: string;
    redirectEntryFiles: readonly string[];
    providerOrchestratorProfiles: readonly ProviderOrchestratorProfile[];
    githubSkillBridgeProfiles: readonly GitHubSkillBridgeProfile[];
    providerMinimalism: boolean;
    reviewSkillBridgeHostEntrypoint: string;
    providerBridgePaths: readonly string[];
    filesystem: InstallFilesystemStage;
}

export interface InstallProviderEntrypointStageResult {
    preserved: number;
}

export function runInstallProviderEntrypointStage(
    options: RunInstallProviderEntrypointStageOptions
): InstallProviderEntrypointStageResult {
    const {
        targetRoot,
        canonicalEntryFile,
        redirectEntryFiles,
        providerOrchestratorProfiles,
        githubSkillBridgeProfiles,
        providerMinimalism,
        reviewSkillBridgeHostEntrypoint,
        providerBridgePaths,
        filesystem
    } = options;
    const { metrics } = filesystem;

    for (const profile of providerOrchestratorProfiles) {
        const block = buildProviderOrchestratorAgentContent(
            profile.providerLabel,
            canonicalEntryFile,
            profile.orchestratorRelativePath
        );
        filesystem.applyEntrypointManagedBlock(profile.orchestratorRelativePath, block);
    }
    filesystem.applyEntrypointManagedBlock(
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        buildSharedStartTaskWorkflowContent(canonicalEntryFile)
    );

    for (const profile of githubSkillBridgeProfiles) {
        const block = buildGitHubSkillBridgeAgentContent(
            profile.profileTitle,
            canonicalEntryFile,
            profile.skillPath,
            profile.reviewRequirement,
            profile.capabilityFlag
        );
        filesystem.applyEntrypointManagedBlock(profile.relativePath, block);
    }

    const desiredManagedFileSet = new Set([
        canonicalEntryFile,
        ...redirectEntryFiles,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...providerOrchestratorProfiles.map((profile) => profile.orchestratorRelativePath),
        ...githubSkillBridgeProfiles.map((profile) => profile.relativePath)
    ]);

    const allProviderProfiles = getProviderOrchestratorProfileDefinitions();
    const allSkillBridgeProfiles = getGitHubSkillBridgeProfileDefinitions();
    const allManagedFileCandidates = [
        ...ALL_AGENT_ENTRYPOINT_FILES,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...allProviderProfiles.map((profile) => profile.orchestratorRelativePath),
        ...allSkillBridgeProfiles.map((profile) => profile.relativePath)
    ];
    const allEntrypointFileSet = new Set(ALL_AGENT_ENTRYPOINT_FILES as readonly string[]);
    const allProviderBridgeMap = new Map(
        allProviderProfiles.map((profile) => [
            profile.orchestratorRelativePath,
            profile
        ])
    );
    const allSkillBridgeSet = new Set(
        allSkillBridgeProfiles.map((profile) => profile.relativePath)
    );

    function fileHasManagedMarkers(filePath: string): boolean {
        if (!pathExists(filePath)) return false;
        const content = readTextFile(filePath);
        return content.includes(MANAGED_START) && content.includes(MANAGED_END);
    }

    const preservedSet = new Set<string>();
    const preservedBridgePaths: string[] = [];
    let preserved = 0;

    if (!providerMinimalism) {
        for (const relativePath of allManagedFileCandidates) {
            if (desiredManagedFileSet.has(relativePath)) {
                continue;
            }
            const destPath = path.join(targetRoot, relativePath);
            if (!pathExists(destPath) || !fileHasManagedMarkers(destPath)) {
                continue;
            }

            preservedSet.add(relativePath);
            desiredManagedFileSet.add(relativePath);

            if (
                allEntrypointFileSet.has(relativePath)
                && relativePath !== canonicalEntryFile
            ) {
                const providerProfile = allProviderProfiles.find(
                    (profile) => profile.entrypointFile === relativePath
                );
                if (
                    providerProfile
                    && !desiredManagedFileSet.has(
                        providerProfile.orchestratorRelativePath
                    )
                ) {
                    const bridgePath = path.join(
                        targetRoot,
                        providerProfile.orchestratorRelativePath
                    );
                    if (fileHasManagedMarkers(bridgePath)) {
                        preservedSet.add(providerProfile.orchestratorRelativePath);
                        desiredManagedFileSet.add(
                            providerProfile.orchestratorRelativePath
                        );
                        preservedBridgePaths.push(
                            providerProfile.orchestratorRelativePath
                        );
                    }
                    if (
                        reviewSkillBridgeHostEntrypoint
                        && relativePath === reviewSkillBridgeHostEntrypoint
                    ) {
                        for (const skillProfile of allSkillBridgeProfiles) {
                            if (!desiredManagedFileSet.has(skillProfile.relativePath)) {
                                const skillBridgePath = path.join(
                                    targetRoot,
                                    skillProfile.relativePath
                                );
                                if (fileHasManagedMarkers(skillBridgePath)) {
                                    preservedSet.add(skillProfile.relativePath);
                                    desiredManagedFileSet.add(skillProfile.relativePath);
                                }
                            }
                        }
                    }
                }
            } else if (allProviderBridgeMap.has(relativePath)) {
                preservedBridgePaths.push(relativePath);
            }
        }
    } else {
        for (const relativePath of allManagedFileCandidates) {
            if (desiredManagedFileSet.has(relativePath)) {
                continue;
            }
            const destPath = path.join(targetRoot, relativePath);
            if (
                filesystem.removeManagedBlockOrFileOnDisk(
                    destPath,
                    relativePath
                )
            ) {
                metrics.aligned++;
            }
        }
    }

    const allBridgePaths = [...providerBridgePaths, ...preservedBridgePaths];
    for (const relativePath of preservedSet) {
        const destPath = path.join(targetRoot, relativePath);

        if (
            allEntrypointFileSet.has(relativePath)
            && relativePath !== canonicalEntryFile
        ) {
            const redirectBlock = buildRedirectManagedBlock(
                relativePath,
                canonicalEntryFile,
                allBridgePaths
            );
            if (
                filesystem.syncManagedBlockOnDisk(
                    destPath,
                    relativePath,
                    redirectBlock
                )
            ) {
                metrics.aligned++;
            }
            preserved++;
        } else if (allProviderBridgeMap.has(relativePath)) {
            const profile = allProviderBridgeMap.get(relativePath)!;
            const bridgeBlock = buildProviderOrchestratorAgentContent(
                profile.providerLabel,
                canonicalEntryFile,
                profile.orchestratorRelativePath
            );
            if (
                filesystem.syncManagedBlockOnDisk(
                    destPath,
                    relativePath,
                    bridgeBlock
                )
            ) {
                metrics.aligned++;
            }
            preserved++;
        } else if (allSkillBridgeSet.has(relativePath)) {
            const skillProfile = allSkillBridgeProfiles.find(
                (profile) => profile.relativePath === relativePath
            )!;
            const block = buildGitHubSkillBridgeAgentContent(
                skillProfile.profileTitle,
                canonicalEntryFile,
                skillProfile.skillPath,
                skillProfile.reviewRequirement,
                skillProfile.capabilityFlag
            );
            if (
                filesystem.syncManagedBlockOnDisk(
                    destPath,
                    relativePath,
                    block
                )
            ) {
                metrics.aligned++;
            }
            preserved++;
        } else {
            preserved++;
        }
    }

    return { preserved };
}
