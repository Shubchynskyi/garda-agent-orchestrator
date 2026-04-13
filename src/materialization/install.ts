import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES } from '../core/constants';
import { ensureDirectory, pathExists, readTextFile } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';
import { normalizeLineEndings } from '../core/line-endings';
import { resolvePathInsideRoot } from '../core/paths';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { validateInitAnswers } from '../schemas/init-answers';
import {
    getCanonicalEntrypointFile,
    getActiveAgentEntrypointFiles,
    convertActiveAgentEntrypointFilesToString,
    getProviderOrchestratorProfileDefinitions,
    getGitHubSkillBridgeProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from './common';
import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END,
    INSTALL_BACKUP_CANDIDATE_PATHS,
    buildTaskManagedBlockWithExistingQueue,
    buildCanonicalManagedBlock,
      buildRedirectManagedBlock,
      buildCommitGuardManagedBlock,
      buildProviderOrchestratorAgentContent,
      buildSharedStartTaskWorkflowContent,
      buildGitHubSkillBridgeAgentContent,
    buildQwenSettingsContent,
    buildClaudeLocalSettingsContent,
    buildVscodeSettingsContent,
    buildGitignoreEntries,
    syncManagedGitignoreBlockInContent,
    syncManagedBlockInContent
} from './content-builders';
import { withLifecycleOperationLock } from '../lifecycle/common';

interface RunInstallOptions {
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
    initRunner?: (options: {
        targetRoot: string;
        assistantLanguage: string;
        assistantBrevity: string;
        sourceOfTruth: string;
        enforceNoAutoCommit: boolean;
        tokenEconomyEnabled: boolean;
    }) => void;
}

type BackupFileCallback = (destPath: string, relativePath: string) => void;

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatInstallBackupTimestamp(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, '0');
    const pad3 = (value: number): string => String(value).padStart(3, '0');
    return [
        String(date.getUTCFullYear()),
        pad2(date.getUTCMonth() + 1),
        pad2(date.getUTCDate())
    ].join('') + '-' + [
        pad2(date.getUTCHours()),
        pad2(date.getUTCMinutes()),
        pad2(date.getUTCSeconds())
    ].join('') + '-' + pad3(date.getUTCMilliseconds());
}

function createUniqueInstallBackupRoot(bundleRoot: string): { timestamp: string; backupRoot: string } {
    const backupsRoot = path.join(bundleRoot, 'runtime', 'backups');
    const baseTimestamp = formatInstallBackupTimestamp(new Date());
    let candidateTimestamp = baseTimestamp;
    let suffix = 1;

    while (pathExists(path.join(backupsRoot, candidateTimestamp))) {
        candidateTimestamp = `${baseTimestamp}-${String(suffix).padStart(2, '0')}`;
        suffix += 1;
    }

    return {
        timestamp: candidateTimestamp,
        backupRoot: path.join(backupsRoot, candidateTimestamp)
    };
}

/**
 * Runs the install materialization pipeline.
 * Main entry point for the Node install lifecycle.
 *
 * @param {object} options
 * @param {string} options.targetRoot - Project root directory
 * @param {string} options.bundleRoot - Orchestrator bundle directory
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.preserveExisting=true]
 * @param {boolean} [options.alignExisting=true]
 * @param {boolean} [options.runInit=true]
 * @param {boolean} [options.answerDependentOnly=false]
 * @param {boolean} [options.skipBackups=false]
 * @param {string} options.assistantLanguage
 * @param {string} options.assistantBrevity
 * @param {string} options.sourceOfTruth
 * @param {string} options.initAnswersPath
 * @param {Function} [options.initRunner] - Optional callback to run init
 * @returns {object} Install result metrics
 */
export function runInstall(options: RunInstallOptions) {
    const {
        targetRoot,
        bundleRoot,
        dryRun = false,
        preserveExisting = true,
        alignExisting = true,
        runInit = true,
        answerDependentOnly = false,
        skipBackups = false,
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth,
        initAnswersPath,
        initRunner
    } = options;

    const sourceRoot = path.join(bundleRoot, 'template');

    // Validate template directory
    if (!pathExists(sourceRoot)) {
        throw new Error(`Template directory not found: ${sourceRoot}`);
    }

    // Validate target root doesn't point to bundle
    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }

    // Validate and normalize parameters
    const trimmedLanguage = (assistantLanguage || '').trim();
    if (!trimmedLanguage) {
        throw new Error('AssistantLanguage must not be empty.');
    }
    const trimmedBrevity = (assistantBrevity || '').trim().toLowerCase();
    const trimmedSourceOfTruth = (sourceOfTruth || '').trim();

    return withLifecycleOperationLock(normalizedTarget, 'install', () => {
    // Read and validate init answers
    const resolvedInitPath = resolvePathInsideRoot(targetRoot, initAnswersPath);
    if (!pathExists(resolvedInitPath)) {
        throw new Error(`Init answers file not found: ${resolvedInitPath}`);
    }

    const initAnswersRaw = readJsonFile(resolvedInitPath);
    const initAnswers = validateInitAnswers(initAnswersRaw);

    // Cross-validate parameters vs init answers
    if (initAnswers.AssistantLanguage.toLowerCase() !== trimmedLanguage.toLowerCase()) {
        throw new Error(
            `AssistantLanguage parameter '${trimmedLanguage}' does not match init answers artifact value '${initAnswers.AssistantLanguage}'.`
        );
    }
    if (initAnswers.AssistantBrevity !== trimmedBrevity) {
        throw new Error(
            `AssistantBrevity parameter '${trimmedBrevity}' does not match init answers artifact value '${initAnswers.AssistantBrevity}'.`
        );
    }
    if (initAnswers.SourceOfTruth.toUpperCase().replace(/\s+/g, '') !== trimmedSourceOfTruth.toUpperCase().replace(/\s+/g, '')) {
        throw new Error(
            `SourceOfTruth parameter '${trimmedSourceOfTruth}' does not match init answers artifact value '${initAnswers.SourceOfTruth}'.`
        );
    }

    const enforceNoAutoCommit = initAnswers.EnforceNoAutoCommit;
    const enableClaudeOrchestratorFullAccess = initAnswers.ClaudeOrchestratorFullAccess;
    const tokenEconomyEnabled = initAnswers.TokenEconomyEnabled;
    const providerMinimalism = initAnswers.ProviderMinimalism;

    const canonicalEntryFile = getCanonicalEntrypointFile(initAnswers.SourceOfTruth);
    const activeEntryFilesSeed = initAnswers.ActiveAgentFiles
        ? initAnswers.ActiveAgentFiles.join(', ')
        : null;
    let activeEntryFiles = getActiveAgentEntrypointFiles(activeEntryFilesSeed, initAnswers.SourceOfTruth);
    if (activeEntryFiles.length === 0) {
        activeEntryFiles = [canonicalEntryFile];
    }
    const redirectEntryFiles = activeEntryFiles.filter((f) => f !== canonicalEntryFile);

    const providerOrchestratorProfiles = getProviderOrchestratorProfileDefinitions().filter(
        (p) => activeEntryFiles.includes(p.entrypointFile)
    );
    const githubSkillBridgeProfiles = activeEntryFiles.includes('.github/copilot-instructions.md')
        ? getGitHubSkillBridgeProfileDefinitions()
        : [];
    const providerBridgePaths = providerOrchestratorProfiles.map((p) => p.orchestratorRelativePath);

    // Setup
    const backupLocation = createUniqueInstallBackupRoot(bundleRoot);
    const timestamp = backupLocation.timestamp;
    const backupRoot = backupLocation.backupRoot;
    const deploymentDate = new Date().toISOString().slice(0, 10);
    const bundleVersionPath = path.join(bundleRoot, 'VERSION');
    const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');

    if (!pathExists(bundleVersionPath)) {
        throw new Error(`Bundle version file not found: ${bundleVersionPath}`);
    }
    const bundleVersion = readTextFile(bundleVersionPath).trim();
    if (!bundleVersion) {
        throw new Error(`Bundle version file is empty: ${bundleVersionPath}`);
    }

    // Counters
    let deployed = 0;
    let backedUp = 0;
    let skippedExisting = 0;
    let aligned = 0;
    let forcedOverwrites = 0;
    let initInvoked = false;
    const backedUpSet = new Set<string>();

    // Pre-existing file tracking
    const preExistingPaths = INSTALL_BACKUP_CANDIDATE_PATHS
        .filter((p) => pathExists(path.join(targetRoot, p)))
        .sort();

    // Backup manifest
    if (!skipBackups && !dryRun && preExistingPaths.length > 0) {
        const manifestDir = path.dirname(path.join(backupRoot, '_install-backup.manifest.json'));
        ensureDirectory(manifestDir);
        writeJsonFile(path.join(backupRoot, '_install-backup.manifest.json'), {
            Version: 1,
            CreatedAt: timestamp,
            PreExistingFiles: preExistingPaths
        });
    }

    // Backup helper
    function backupFile(destPath: string, relativePath: string): void {
        if (skipBackups || !pathExists(destPath)) return;
        const key = relativePath.toLowerCase().replace(/\\/g, '/');
        if (backedUpSet.has(key)) return;
        if (!dryRun) {
            const backupPath = path.join(backupRoot, relativePath);
            ensureDirectory(path.dirname(backupPath));
            fs.copyFileSync(destPath, backupPath);
        }
        backedUp++;
        backedUpSet.add(key);
    }

    // Sync managed block into a file on disk
    function syncManagedBlockOnDisk(destPath: string, relativePath: string, managedBlock: string): boolean {
        if (!pathExists(destPath)) return false;
        const content = readTextFile(destPath);
        const result = syncManagedBlockInContent(content, managedBlock);
        if (!result.changed) return false;
        backupFile(destPath, relativePath);
        if (!dryRun) {
            fs.writeFileSync(destPath, result.content, 'utf8');
        }
        return true;
    }

    function removeEmptyParentDirectories(startDir: string): void {
        let current = path.resolve(startDir);
        const root = path.resolve(targetRoot);
        while (current !== root) {
            const relative = path.relative(root, current);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
                return;
            }
            if (!pathExists(current) || !fs.statSync(current).isDirectory() || fs.readdirSync(current).length > 0) {
                return;
            }
            fs.rmdirSync(current);
            current = path.dirname(current);
        }
    }

    function removeManagedBlockOrFileOnDisk(destPath: string, relativePath: string): boolean {
        if (!pathExists(destPath) || !fs.statSync(destPath).isFile()) return false;
        const content = readTextFile(destPath);
        const pattern = new RegExp(
            `${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`, 'm'
        );
        if (!pattern.test(content)) return false;
        const nextContent = content.replace(pattern, '').trim();
        backupFile(destPath, relativePath);
        if (!dryRun) {
            if (nextContent) {
                fs.writeFileSync(destPath, `${nextContent}${content.includes('\r\n') ? '\r\n' : '\n'}`, 'utf8');
            } else {
                fs.rmSync(destPath, { force: true });
                removeEmptyParentDirectories(path.dirname(destPath));
            }
        }
        return true;
    }

    // Apply entrypoint managed block
    function applyEntrypointManagedBlock(relativePath: string, managedBlock: string): void {
        const destPath = path.join(targetRoot, relativePath);
        const destDir = path.dirname(destPath);
        if (!pathExists(destPath)) {
            if (!dryRun) {
                ensureDirectory(destDir);
                fs.writeFileSync(destPath, managedBlock + '\r\n', 'utf8');
            }
            deployed++;
            return;
        }
        if (syncManagedBlockOnDisk(destPath, relativePath, managedBlock)) {
            aligned++;
        }
    }

    // Template content with placeholder replacements
    function getTemplateContent(sourcePath: string, relativePath: string): string | null {
        if (!pathExists(sourcePath)) return null;
        let content = readTextFile(sourcePath);
        if (!content || !content.trim()) return null;
        const norm = relativePath.replace(/\\/g, '/');
        if (norm === 'TASK.md') {
            content = content.replaceAll('{{DEPLOYMENT_DATE}}', deploymentDate);
            content = content.replaceAll('{{CANONICAL_ENTRYPOINT}}', canonicalEntryFile);
        }
        return content;
    }

    // Deploy exact files
    const exactFiles = ['TASK.md'];
    if (!answerDependentOnly) {
        for (const relPath of exactFiles) {
            const sourcePath = path.join(sourceRoot, relPath);
            if (!pathExists(sourcePath)) continue;
            const destPath = path.join(targetRoot, relPath);
            const destDir = path.dirname(destPath);
            if (!pathExists(destDir) && !dryRun) {
                ensureDirectory(destDir);
            }

            if (pathExists(destPath)) {
                if (preserveExisting) {
                    skippedExisting++;
                    if (relPath === 'TASK.md') {
                        const templateContent = getTemplateContent(sourcePath, relPath);
                        const existingContent = readTextFile(destPath);
                        if (templateContent !== null) {
                            const taskBlock = buildTaskManagedBlockWithExistingQueue(templateContent, existingContent);
                            if (taskBlock) {
                                if (syncManagedBlockOnDisk(destPath, relPath, taskBlock)) {
                                    aligned++;
                                }
                            }
                        }
                    }
                    continue;
                }
                backupFile(destPath, relPath);
            }

            const content = getTemplateContent(sourcePath, relPath);
            if (content && !dryRun) {
                fs.writeFileSync(destPath, content, 'utf8');
            }
            deployed++;
        }
    } else {
        // Answer-dependent only: just sync TASK.md managed block
        const taskSourcePath = path.join(sourceRoot, 'TASK.md');
        const taskDestPath = path.join(targetRoot, 'TASK.md');

        if (pathExists(taskSourcePath)) {
            if (pathExists(taskDestPath)) {
                const templateContent = getTemplateContent(taskSourcePath, 'TASK.md');
                const existingContent = readTextFile(taskDestPath);
                if (templateContent !== null) {
                    const taskBlock = buildTaskManagedBlockWithExistingQueue(templateContent, existingContent);
                    if (taskBlock) {
                        if (syncManagedBlockOnDisk(taskDestPath, 'TASK.md', taskBlock)) {
                            aligned++;
                        }
                    }
                }
            } else {
                if (!dryRun) {
                    ensureDirectory(path.dirname(taskDestPath));
                    const content = getTemplateContent(taskSourcePath, 'TASK.md');
                    if (content) {
                        fs.writeFileSync(taskDestPath, content, 'utf8');
                    }
                }
                deployed++;
            }
        }
    }

    // Apply canonical entrypoint managed block
    const templateClaudeContent = readTextFile(path.join(sourceRoot, 'CLAUDE.md'));
    const canonicalBlock = buildCanonicalManagedBlock(canonicalEntryFile, templateClaudeContent);
    applyEntrypointManagedBlock(canonicalEntryFile, canonicalBlock);

    // Apply redirect entrypoint managed blocks
    for (const redirectFile of redirectEntryFiles) {
        const redirectBlock = buildRedirectManagedBlock(redirectFile, canonicalEntryFile, providerBridgePaths);
        applyEntrypointManagedBlock(redirectFile, redirectBlock);
    }

    // Qwen settings
    const qwenRelPath = '.qwen/settings.json';
    const qwenPath = path.join(targetRoot, qwenRelPath);
    const qwenExists = pathExists(qwenPath);
    let qwenExisting = null;
    if (qwenExists) {
        qwenExisting = readTextFile(qwenPath);
    }
    const qwenPlan = qwenExists
        ? buildQwenSettingsContent(qwenExisting, ['TASK.md', canonicalEntryFile])
        : { content: null, needsUpdate: false, parseMode: 'not-present' };
    let qwenUpdated = false;

    if (qwenExists) {
        if (!preserveExisting || qwenPlan.needsUpdate) {
            backupFile(qwenPath, qwenRelPath);
            if (!dryRun) {
                ensureDirectory(path.dirname(qwenPath));
                if (qwenPlan.content !== null) {
                    fs.writeFileSync(qwenPath, qwenPlan.content, 'utf8');
                }
            }
            qwenUpdated = true;
            if (preserveExisting) aligned++;
            else deployed++;
        }
    }

    // Claude local settings
    const claudeRelPath = '.claude/settings.local.json';
    const claudePath = path.join(targetRoot, claudeRelPath);
    let claudeExisting = null;
    if (pathExists(claudePath)) {
        claudeExisting = readTextFile(claudePath);
    }
    const claudePlan = buildClaudeLocalSettingsContent(claudeExisting, enableClaudeOrchestratorFullAccess);
    let claudeUpdated = false;
    let claudeParseMode: string = claudePlan.parseMode;
    let claudeNeedsUpdate = claudePlan.needsUpdate;

    if (enableClaudeOrchestratorFullAccess) {
        if (pathExists(claudePath)) {
            if (!preserveExisting || claudePlan.needsUpdate) {
                backupFile(claudePath, claudeRelPath);
                if (!dryRun) {
                    ensureDirectory(path.dirname(claudePath));
                    fs.writeFileSync(claudePath, claudePlan.content, 'utf8');
                }
                claudeUpdated = true;
                if (preserveExisting) aligned++;
                else deployed++;
            }
        } else {
            if (!dryRun) {
                ensureDirectory(path.dirname(claudePath));
                fs.writeFileSync(claudePath, claudePlan.content, 'utf8');
            }
            claudeUpdated = true;
            deployed++;
        }
    } else {
        claudeParseMode = 'disabled_by_init_answer';
        claudeNeedsUpdate = false;
    }

    // VS Code settings — IDE exclude patterns for generated directories
    const vscodeRelPath = '.vscode/settings.json';
    const vscodePath = path.join(targetRoot, vscodeRelPath);
    const vscodeExisting = pathExists(vscodePath) ? readTextFile(vscodePath) : null;
    const vscodePlan = buildVscodeSettingsContent(vscodeExisting);
    let vscodeSettingsUpdated = false;

    if (vscodePlan.needsUpdate) {
        if (pathExists(vscodePath)) {
            backupFile(vscodePath, vscodeRelPath);
        }
        if (!dryRun) {
            ensureDirectory(path.dirname(vscodePath));
            fs.writeFileSync(vscodePath, vscodePlan.content, 'utf8');
        }
        vscodeSettingsUpdated = true;
        if (pathExists(vscodePath) && preserveExisting) aligned++;
        else deployed++;
    }

    // Provider orchestrator profiles
    for (const profile of providerOrchestratorProfiles) {
        const block = buildProviderOrchestratorAgentContent(
            profile.providerLabel, canonicalEntryFile, profile.orchestratorRelativePath
        );
        applyEntrypointManagedBlock(profile.orchestratorRelativePath, block);
    }
    applyEntrypointManagedBlock(
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        buildSharedStartTaskWorkflowContent(canonicalEntryFile)
    );

    // GitHub skill bridge profiles
    for (const profile of githubSkillBridgeProfiles) {
        const block = buildGitHubSkillBridgeAgentContent(
            profile.profileTitle, canonicalEntryFile,
            profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
        );
        applyEntrypointManagedBlock(profile.relativePath, block);
    }

    // T-1009: preserve user-retained entrypoints on update.
    // Previously, any managed file not in ActiveAgentFiles was removed.
    // Now we detect pre-existing managed files on disk and preserve them
    // as redirect entrypoints / provider bridges instead of deleting them.
    // Two-pass approach: discover all preserved files first, then sync content.
    //
    // When ProviderMinimalism=true, remove stale managed provider files instead
    // of preserving them as redirects / bridges.
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
    const allProviderBridgeMap = new Map(allProviderProfiles.map((p) => [p.orchestratorRelativePath, p]));
    const allSkillBridgeSet = new Set(allSkillBridgeProfiles.map((p) => p.relativePath));

    function fileHasManagedMarkers(filePath: string): boolean {
        if (!pathExists(filePath)) return false;
        const content = readTextFile(filePath);
        return content.includes(MANAGED_START) && content.includes(MANAGED_END);
    }

    // Pass 1: discover all preserved files and collect bridge paths
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

            if (allEntrypointFileSet.has(relativePath) && relativePath !== canonicalEntryFile) {
                // Cascade: discover associated provider bridge
                const providerProfile = allProviderProfiles.find((p) => p.entrypointFile === relativePath);
                if (providerProfile && !desiredManagedFileSet.has(providerProfile.orchestratorRelativePath)) {
                    const bridgePath = path.join(targetRoot, providerProfile.orchestratorRelativePath);
                    if (fileHasManagedMarkers(bridgePath)) {
                        preservedSet.add(providerProfile.orchestratorRelativePath);
                        desiredManagedFileSet.add(providerProfile.orchestratorRelativePath);
                        preservedBridgePaths.push(providerProfile.orchestratorRelativePath);
                    }
                    // Cascade: discover associated skill bridges for GitHub Copilot
                    if (relativePath === '.github/copilot-instructions.md') {
                        for (const skillProfile of allSkillBridgeProfiles) {
                            if (!desiredManagedFileSet.has(skillProfile.relativePath)) {
                                const skillBridgePath = path.join(targetRoot, skillProfile.relativePath);
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
            if (removeManagedBlockOrFileOnDisk(destPath, relativePath)) {
                aligned++;
            }
        }
    }

    // Pass 2: sync content for all preserved files with complete bridge knowledge
    const allBridgePaths = [...providerBridgePaths, ...preservedBridgePaths];

    for (const relativePath of preservedSet) {
        const destPath = path.join(targetRoot, relativePath);

        if (allEntrypointFileSet.has(relativePath) && relativePath !== canonicalEntryFile) {
            const redirectBlock = buildRedirectManagedBlock(relativePath, canonicalEntryFile, allBridgePaths);
            if (syncManagedBlockOnDisk(destPath, relativePath, redirectBlock)) {
                aligned++;
            }
            preserved++;
        } else if (allProviderBridgeMap.has(relativePath)) {
            const profile = allProviderBridgeMap.get(relativePath)!;
            const bridgeBlock = buildProviderOrchestratorAgentContent(
                profile.providerLabel, canonicalEntryFile, profile.orchestratorRelativePath
            );
            if (syncManagedBlockOnDisk(destPath, relativePath, bridgeBlock)) {
                aligned++;
            }
            preserved++;
        } else if (allSkillBridgeSet.has(relativePath)) {
            const skillProfile = allSkillBridgeProfiles.find((p) => p.relativePath === relativePath)!;
            const block = buildGitHubSkillBridgeAgentContent(
                skillProfile.profileTitle, canonicalEntryFile,
                skillProfile.skillPath, skillProfile.reviewRequirement, skillProfile.capabilityFlag
            );
            if (syncManagedBlockOnDisk(destPath, relativePath, block)) {
                aligned++;
            }
            preserved++;
        } else {
            preserved++;
        }
    }

    // Gitignore
    const gitignoreEntryList = buildGitignoreEntries(
        activeEntryFiles, providerOrchestratorProfiles, enableClaudeOrchestratorFullAccess, qwenExists,
        providerMinimalism
    );
    let gitignoreAdded = 0;
    const gitignorePath = path.join(targetRoot, '.gitignore');
    if (!dryRun) {
        const gitignoreExisted = pathExists(gitignorePath);
        const existingContent = gitignoreExisted ? readTextFile(gitignorePath) : '';
        const syncResult = syncManagedGitignoreBlockInContent(
            existingContent,
            gitignoreEntryList,
            enableClaudeOrchestratorFullAccess
        );
        gitignoreAdded = syncResult.addedEntries;
        if (syncResult.changed) {
            if (gitignoreExisted) {
                backupFile(gitignorePath, '.gitignore');
            }
            fs.writeFileSync(gitignorePath, syncResult.content, 'utf8');
        }
    } else {
        const existingContent = pathExists(gitignorePath) ? readTextFile(gitignorePath) : '';
        gitignoreAdded = syncManagedGitignoreBlockInContent(
            existingContent,
            gitignoreEntryList,
            enableClaudeOrchestratorFullAccess
        ).addedEntries;
    }

    // Commit guard hook
    const commitGuardHookUpdated = applyCommitGuardHook(targetRoot, enforceNoAutoCommit, dryRun, backupFile);

    // Run init if requested
    if (runInit && !dryRun && initRunner) {
        initRunner({
            targetRoot,
            assistantLanguage: trimmedLanguage,
            assistantBrevity: trimmedBrevity,
            sourceOfTruth: initAnswers.SourceOfTruth,
            enforceNoAutoCommit,
            tokenEconomyEnabled
        });
        initInvoked = true;
    }

    // Write live/version.json
    let liveVersionWritten = false;
    let protectedControlPlaneManifestWritten = false;
    if (!dryRun) {
        ensureDirectory(path.dirname(liveVersionPath));
        writeJsonFile(liveVersionPath, {
            Version: bundleVersion,
            UpdatedAt: new Date().toISOString(),
            SourceOfTruth: initAnswers.SourceOfTruth,
            CanonicalEntrypoint: canonicalEntryFile,
            ActiveAgentFiles: convertActiveAgentEntrypointFilesToString(activeEntryFiles),
            AssistantLanguage: trimmedLanguage,
            AssistantBrevity: trimmedBrevity,
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
        targetRoot: normalizedTarget,
        templateRoot: sourceRoot,
        preserveExisting,
        alignExisting,
        runInit,
        answerDependentOnly,
        skipBackups,
        initAnswersPath: resolvedInitPath,
        deploymentDate,
        bundleVersion,
        assistantLanguage: trimmedLanguage,
        assistantBrevity: trimmedBrevity,
        sourceOfTruth: initAnswers.SourceOfTruth,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess: enableClaudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism,
        canonicalEntrypoint: canonicalEntryFile,
        activeAgentFiles: convertActiveAgentEntrypointFilesToString(activeEntryFiles),
        filesDeployed: deployed,
        filesForcedOverwrite: forcedOverwrites,
        filesSkippedExisting: skippedExisting,
        filesAligned: aligned,
        filesPreserved: preserved,
        filesBackedUp: backedUp,
        gitignoreEntriesAdded: gitignoreAdded,
        qwenSettingsParseMode: qwenPlan.parseMode,
        qwenSettingsNeedsUpdate: qwenPlan.needsUpdate,
        qwenSettingsUpdated: qwenUpdated,
        claudeLocalSettingsParseMode: claudeParseMode,
        claudeLocalSettingsNeedsUpdate: claudeNeedsUpdate,
        claudeLocalSettingsUpdated: claudeUpdated,
        vscodeSettingsUpdated,
        initInvoked,
        preCommitHookUpdated: commitGuardHookUpdated,
        liveVersionWritten,
        protectedControlPlaneManifestWritten,
        backupRoot: dryRun ? null : backupRoot
    };
    });
}

/**
 * Applies or removes the commit guard pre-commit hook.
 */
export function applyCommitGuardHook(
    targetRoot: string,
    enabled: boolean,
    dryRun: boolean,
    backupFile?: BackupFileCallback
): boolean {
    const gitDirPath = path.join(targetRoot, '.git');
    if (!pathExists(gitDirPath)) {
        if (enabled) {
            throw new Error(
                `EnforceNoAutoCommit=true but .git directory is missing at '${gitDirPath}'. Initialize git or set EnforceNoAutoCommit=false in init answers.`
            );
        }
        return false;
    }

    const hookPath = path.join(targetRoot, '.git', 'hooks', 'pre-commit');
    const managedBlock = buildCommitGuardManagedBlock();
    const pattern = new RegExp(
        `${escapeRegex(COMMIT_GUARD_START)}[\\s\\S]*?${escapeRegex(COMMIT_GUARD_END)}`, 'm'
    );

    if (!pathExists(hookPath)) {
        if (!enabled) return false;
        if (!dryRun) {
            ensureDirectory(path.dirname(hookPath));
            const hookContent = '#!/usr/bin/env bash\n\n' + managedBlock + '\n';
            fs.writeFileSync(hookPath, hookContent, 'utf8');
        }
        return true;
    }

    let content = readTextFile(hookPath);
    content = normalizeLineEndings(content, '\n');
    let updatedContent;

    if (enabled) {
        if (pattern.test(content)) {
            updatedContent = content.replace(pattern, managedBlock);
        } else if (!content.trim()) {
            updatedContent = '#!/usr/bin/env bash\n\n' + managedBlock + '\n';
        } else {
            updatedContent = content.trimEnd() + '\n\n' + managedBlock + '\n';
        }
    } else {
        if (pattern.test(content)) {
            updatedContent = content.replace(pattern, '').trimEnd() + '\n';
        } else {
            return false;
        }
    }

    if (updatedContent === content) return false;

    if (backupFile) {
        backupFile(hookPath, '.git/hooks/pre-commit');
    }
    if (!dryRun) {
        fs.writeFileSync(hookPath, updatedContent, 'utf8');
    }
    return true;
}
