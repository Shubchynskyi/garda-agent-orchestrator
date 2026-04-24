import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import { detectLineEnding } from '../core/line-endings';
import { readJsonFile } from '../core/json';
import { SHARED_START_TASK_WORKFLOW_RELATIVE_PATH } from '../materialization/common';
import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END,
    getClaudeOrchestratorAllowEntries,
    GITIGNORE_MANAGED_COMMENT,
    getLegacyUninstallBackupGitignoreEntry,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT,
    getUninstallBackupGitignoreEntry
} from '../materialization/content-builders';
import {
    copyPathRecursive,
    createRollbackSnapshot,
    ensureRelativeSafe,
    ensureWithinRoot,
    getTimestamp,
    readUninstallSentinel,
    removePathRecursive,
    removeUninstallSentinel,
    restoreRollbackSnapshot,
    type RollbackRecord,
    validateTargetRoot,
    withLifecycleOperationLock,
    writeRollbackRecords,
    writeUninstallSentinel
} from './common';
import {
    CLAUDE_LOCAL_SETTINGS_RELATIVE,
    ENTRYPOINT_FILES,
    escapeRegex,
    getInitializationBackupManifest,
    getInitializationBackupRoot,
    getUninstallRollbackItems,
    GITHUB_SKILL_BRIDGE_FILES,
    GITIGNORE_MANAGED_ENTRIES,
    looksLikeManagedFileWithoutMarkers,
    normalizeTextAfterManagedBlockRemoval,
    parseBooleanAnswer,
    PRE_COMMIT_HOOK_RELATIVE,
    PROVIDER_AGENT_FILES,
    QWEN_SETTINGS_RELATIVE,
    removeEmptyDirectoriesUpwards,
    shouldRestoreItemFromInitializationBackup,
    tryDetectCanonicalEntrypointFromManagedFiles,
    tryGetActiveAgentFilesFromJsonFile,
    tryGetCanonicalEntrypointFromJsonFile
} from './uninstall-helpers';

type JsonObject = Record<string, unknown>;

interface QwenSettingsContext extends JsonObject {
    fileName?: unknown;
}

interface QwenSettings extends JsonObject {
    context?: QwenSettingsContext;
}

interface ClaudeLocalSettingsPermissions extends JsonObject {
    allow?: unknown;
}

interface ClaudeLocalSettings extends JsonObject {
    permissions?: ClaudeLocalSettingsPermissions;
}

interface UninstallTestHooks {
    afterFileCleanup?: () => void;
}

export interface RunUninstallOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    dryRun?: boolean;
    skipBackups?: boolean;
    noPrompt?: boolean;
    keepPrimaryEntrypoint?: string | boolean | null;
    keepTaskFile?: string | boolean | null;
    keepRuntimeArtifacts?: string | boolean | null;
    _testHooks?: UninstallTestHooks;
}

export interface RunUninstallResult {
    targetRoot: string;
    orchestratorRoot: string;
    initAnswersPath: string;
    initializationBackupRoot: string;
    canonicalEntrypoint: string;
    keepPrimaryEntrypoint: boolean;
    keepTaskFile: boolean;
    keepRuntimeArtifacts: boolean;
    dryRun: boolean;
    skipBackups: boolean;
    backupRoot: string;
    preservedRuntimePath: string;
    preservedProjectMemoryPath: string;
    filesUpdated: number;
    filesDeleted: number;
    filesRestored: number;
    directoriesDeleted: number;
    itemsBackedUp: number;
    rollbackStatus: string;
    warningsCount: number;
    warnings: string[];
    result: 'DRY_RUN' | 'SUCCESS';
    previewAffectedFiles: string[];
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runUninstall(options: RunUninstallOptions): RunUninstallResult {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        dryRun = false,
        skipBackups = false,
        keepPrimaryEntrypoint,
        keepTaskFile,
        keepRuntimeArtifacts
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    return withLifecycleOperationLock(normalizedTarget, 'uninstall', () => {
        const orchestratorRoot = path.join(normalizedTarget, resolveBundleName());

        let initAnswersCandidatePath: string;
        if (path.isAbsolute(initAnswersPath)) {
            initAnswersCandidatePath = initAnswersPath;
        } else {
            initAnswersCandidatePath = path.resolve(normalizedTarget, initAnswersPath);
        }
        ensureWithinRoot(normalizedTarget, initAnswersCandidatePath, 'Uninstall init answers path');

        const liveVersionPath = path.join(orchestratorRoot, 'live', 'version.json');
        const timestamp = getTimestamp();

        let backupRoot: string | null = null;
        const backedUpSet = new Set<string>();
        let itemsBackedUp = 0;
        let deletedFiles = 0;
        let updatedFiles = 0;
        let deletedDirectories = 0;
        let restoredFiles = 0;
        const warnings: string[] = [];
        const previewAffectedFiles: string[] = [];
        let preservedRuntimePath: string | null = null;
        let preservedProjectMemoryPath: string | null = null;
        let rollbackSnapshotPath: string | null = null;
        let rollbackRecords: RollbackRecord[] = [];
        let rollbackStatus = 'NOT_NEEDED';
        let currentPhase = 'INIT';
        const journalRoot = path.join(normalizedTarget, `${resolveBundleName()}-uninstall-journal`);

        if (!dryRun) {
            const existingSentinel = readUninstallSentinel(normalizedTarget);
            if (existingSentinel) {
                warnings.push(
                    `Detected interrupted uninstall from ${existingSentinel.startedAt || 'unknown time'}. ` +
                    `Previous journal: ${existingSentinel.rollbackSnapshotPath || 'unknown'}. Proceeding with fresh uninstall.`
                );
            }
        }

        const initBackupRoot = getInitializationBackupRoot(orchestratorRoot);
        const initBackupManifest = getInitializationBackupManifest(initBackupRoot);

        function getBackupRoot(): string {
            if (!backupRoot) {
                backupRoot = path.join(normalizedTarget, `${resolveBundleName()}-uninstall-backups`, timestamp);
            }
            return backupRoot;
        }

        function backupItem(itemPath: string, relativePath: string, _isDirectory: boolean, forcePreserve: boolean): void {
            if (!fs.existsSync(itemPath)) return;
            if (skipBackups && !forcePreserve) return;

            const normalizedRel = relativePath.replace(/\//g, path.sep);
            if (backedUpSet.has(normalizedRel.toLowerCase())) return;

            const backupPath = path.join(getBackupRoot(), normalizedRel);
            if (!dryRun) {
                fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                copyPathRecursive(itemPath, backupPath);
            }

            backedUpSet.add(normalizedRel.toLowerCase());
            itemsBackedUp++;
        }

        function addWarning(message: string): void {
            warnings.push(message);
        }

        function updateOrRemoveFile(filePath: string, relativePath: string, content: string): void {
            backupItem(filePath, relativePath, false, false);
            previewAffectedFiles.push(relativePath);

            if (!content || !content.trim()) {
                if (!dryRun) {
                    fs.rmSync(filePath, { force: true });
                }
                deletedFiles++;
                deletedDirectories += removeEmptyDirectoriesUpwards(path.dirname(filePath), normalizedTarget, dryRun);
                return;
            }

            if (!dryRun) {
                fs.writeFileSync(filePath, content, 'utf8');
            }
            updatedFiles++;
        }

        function removeManagedFile(relativePath: string): void {
            ensureRelativeSafe(relativePath, 'Uninstall managed file path');
            const filePath = path.join(normalizedTarget, relativePath);
            ensureWithinRoot(normalizedTarget, filePath, 'Uninstall managed file');
            if (!pathExists(filePath)) return;

            const content = readTextFile(filePath);
            const pattern = new RegExp(escapeRegex(MANAGED_START) + '[\\s\\S]*?' + escapeRegex(MANAGED_END), '');

            if (!pattern.test(content)) {
                if (looksLikeManagedFileWithoutMarkers(relativePath, content)) {
                    updateOrRemoveFile(filePath, relativePath, '');
                    return;
                }
                addWarning(`Skipping '${relativePath}' because it no longer contains Garda managed block markers.`);
                return;
            }

            const updatedContent = content.replace(pattern, '');
            const normalized = normalizeTextAfterManagedBlockRemoval(updatedContent);
            updateOrRemoveFile(filePath, relativePath, normalized);
        }

        function getInitBackupPath(relativePath: string): string | null {
            if (!initBackupRoot) return null;
            const backupPath = path.join(initBackupRoot, relativePath);
            return fs.existsSync(backupPath) ? backupPath : null;
        }

        function restoreItemFromInitializationBackup(relativePath: string): boolean {
            ensureRelativeSafe(relativePath, 'Uninstall restore path');
            const backupPath = getInitBackupPath(relativePath);
            if (!backupPath) return false;

            if (!shouldRestoreItemFromInitializationBackup(relativePath, backupPath, initBackupManifest, MANAGED_START, MANAGED_END)) {
                return false;
            }

            const destinationPath = path.join(normalizedTarget, relativePath);
            ensureWithinRoot(normalizedTarget, destinationPath, 'Uninstall restore destination');
            backupItem(destinationPath, relativePath, false, false);

            if (!dryRun) {
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                const backupItemStats = fs.lstatSync(backupPath);
                if (fs.existsSync(destinationPath)) {
                    const destinationItem = fs.lstatSync(destinationPath);
                    if (destinationItem.isDirectory() !== backupItemStats.isDirectory()) {
                        removePathRecursive(destinationPath);
                    }
                }
                if (backupItemStats.isDirectory()) {
                    removePathRecursive(destinationPath);
                    copyPathRecursive(backupPath, destinationPath);
                } else {
                    fs.copyFileSync(backupPath, destinationPath);
                }
            }

            restoredFiles++;
            previewAffectedFiles.push(relativePath);
            return true;
        }

        function cleanupQwenSettings(qwenManagedEntries: readonly string[]): void {
            const filePath = path.join(normalizedTarget, QWEN_SETTINGS_RELATIVE);
            if (!pathExists(filePath)) return;

            let settings: unknown;
            try {
                settings = readJsonFile(filePath);
            } catch {
                addWarning(`Skipping '${QWEN_SETTINGS_RELATIVE}' because it is no longer valid JSON.`);
                return;
            }

            if (!isJsonObject(settings)) {
                addWarning(`Skipping '${QWEN_SETTINGS_RELATIVE}' because its JSON root is no longer an object.`);
                return;
            }

            const qwenSettings = settings as QwenSettings;
            if (!qwenSettings.context || typeof qwenSettings.context !== 'object') return;
            const context = qwenSettings.context as QwenSettingsContext;
            const currentEntries = Array.isArray(context.fileName)
                ? context.fileName.filter((entry: unknown) => entry && String(entry).trim()).map((entry: unknown) => String(entry).trim())
                : [];
            const managedSet = new Set<string>(qwenManagedEntries);
            const updatedEntries = currentEntries.filter((entry: string) => !managedSet.has(entry));

            if (updatedEntries.length === currentEntries.length) return;

            const updatedSettings: QwenSettings = { ...qwenSettings };
            const updatedContext: QwenSettingsContext = { ...context };

            if (updatedEntries.length > 0) {
                updatedContext.fileName = updatedEntries;
            } else {
                delete updatedContext.fileName;
            }

            if (Object.keys(updatedContext).length > 0) {
                updatedSettings.context = updatedContext;
            } else {
                delete updatedSettings.context;
            }

            if (Object.keys(updatedSettings).length === 0) {
                updateOrRemoveFile(filePath, QWEN_SETTINGS_RELATIVE, '');
                return;
            }

            updateOrRemoveFile(filePath, QWEN_SETTINGS_RELATIVE, JSON.stringify(updatedSettings, null, 2));
        }

        function cleanupClaudeLocalSettings(): void {
            const filePath = path.join(normalizedTarget, CLAUDE_LOCAL_SETTINGS_RELATIVE);
            if (!pathExists(filePath)) return;

            let settings: unknown;
            try {
                settings = readJsonFile(filePath);
            } catch {
                addWarning(`Skipping '${CLAUDE_LOCAL_SETTINGS_RELATIVE}' because it is no longer valid JSON.`);
                return;
            }

            if (!isJsonObject(settings)) {
                addWarning(`Skipping '${CLAUDE_LOCAL_SETTINGS_RELATIVE}' because its JSON root is no longer an object.`);
                return;
            }

            const claudeSettings = settings as ClaudeLocalSettings;
            if (!claudeSettings.permissions || typeof claudeSettings.permissions !== 'object') return;

            const permissions = claudeSettings.permissions as ClaudeLocalSettingsPermissions;
            const currentAllowEntries = Array.isArray(permissions.allow)
                ? permissions.allow.filter((entry: unknown) => entry && String(entry).trim()).map((entry: unknown) => String(entry).trim())
                : [];
            const managedSet = new Set<string>([...getClaudeOrchestratorAllowEntries()]);
            const updatedAllowEntries = currentAllowEntries.filter((entry: string) => !managedSet.has(entry));

            if (updatedAllowEntries.length === currentAllowEntries.length) return;

            const updatedSettings: ClaudeLocalSettings = { ...claudeSettings };
            const updatedPermissions: ClaudeLocalSettingsPermissions = { ...permissions };

            if (updatedAllowEntries.length > 0) {
                updatedPermissions.allow = updatedAllowEntries;
            } else {
                delete updatedPermissions.allow;
            }

            if (Object.keys(updatedPermissions).length > 0) {
                updatedSettings.permissions = updatedPermissions;
            } else {
                delete updatedSettings.permissions;
            }

            if (Object.keys(updatedSettings).length === 0) {
                updateOrRemoveFile(filePath, CLAUDE_LOCAL_SETTINGS_RELATIVE, '');
                return;
            }

            updateOrRemoveFile(filePath, CLAUDE_LOCAL_SETTINGS_RELATIVE, JSON.stringify(updatedSettings, null, 2));
        }

        function cleanupGitignore(): void {
            const filePath = path.join(normalizedTarget, '.gitignore');
            if (!pathExists(filePath)) return;

            const lines = readTextFile(filePath).split(/\r?\n/);
            const updatedLines = [];
            let changed = false;
            const managedEntrySet = new Set(GITIGNORE_MANAGED_ENTRIES);

            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                if (line === GITIGNORE_MANAGED_COMMENT) {
                    changed = true;
                    i += 1;
                    while (i < lines.length) {
                        const candidate = lines[i];
                        if (managedEntrySet.has(candidate)) {
                            changed = true;
                            i += 1;
                            continue;
                        }
                        i -= 1;
                        break;
                    }
                    continue;
                }
                updatedLines.push(line);
            }

            if (!changed) return;

            const updatedContent = normalizeTextAfterManagedBlockRemoval(updatedLines.join('\r\n'));
            updateOrRemoveFile(filePath, '.gitignore', updatedContent);
        }

        function ensureUninstallBackupGitignoreEntries(): void {
            const ignoreEntry = getUninstallBackupGitignoreEntry();
            const legacyWildcardEntry = getLegacyUninstallBackupGitignoreEntry();
            const commentLine = UNINSTALL_BACKUP_GITIGNORE_COMMENT;

            const filePath = path.join(normalizedTarget, '.gitignore');
            const existingContent = pathExists(filePath) ? readTextFile(filePath) : '';
            const eol = existingContent ? detectLineEnding(existingContent) : '\n';
            const existingLines = existingContent ? existingContent.split(/\r?\n/) : [];

            const hasIgnoreEntry = existingLines.some((line) => line.trim() === ignoreEntry);
            const hasLegacyWildcard = existingLines.some((line) => line.trim() === legacyWildcardEntry);
            const hasComment = existingLines.some((line) => line.trim() === commentLine);

            if (hasIgnoreEntry && hasComment && !hasLegacyWildcard) return;

            const lines = hasLegacyWildcard
                ? existingLines.filter((line) => line.trim() !== legacyWildcardEntry)
                : [...existingLines];

            if (!hasIgnoreEntry) {
                const base = lines.join(eol).trimEnd();
                const parts: string[] = [];
                if (base) parts.push(base);
                parts.push(`${commentLine}${eol}${ignoreEntry}`);
                writeResult(filePath, parts.join(eol + eol) + eol);
            } else {
                if (!hasComment) {
                    const idx = lines.findIndex((line) => line.trim() === ignoreEntry);
                    if (idx >= 0) lines.splice(idx, 0, commentLine);
                }
                writeResult(filePath, lines.join(eol).trimEnd() + eol);
            }

            function writeResult(fp: string, content: string): void {
                if (!dryRun) {
                    fs.mkdirSync(path.dirname(fp), { recursive: true });
                    fs.writeFileSync(fp, content, 'utf8');
                }
                if (existingContent) updatedFiles++;
            }
        }

        function cleanupCommitGuardHook(): void {
            const filePath = path.join(normalizedTarget, PRE_COMMIT_HOOK_RELATIVE);
            if (!pathExists(filePath)) return;

            const content = readTextFile(filePath);
            const pattern = new RegExp(escapeRegex(COMMIT_GUARD_START) + '[\\s\\S]*?' + escapeRegex(COMMIT_GUARD_END), '');
            if (!pattern.test(content)) return;

            let updatedContent = content.replace(pattern, '');
            updatedContent = normalizeTextAfterManagedBlockRemoval(updatedContent);
            if (/^#!\/usr\/bin\/env bash\s*$/.test(updatedContent)) {
                updatedContent = '';
            }

            updateOrRemoveFile(filePath, PRE_COMMIT_HOOK_RELATIVE, updatedContent);
        }

        function removeBundleDirectory(): void {
            if (!fs.existsSync(orchestratorRoot) || !fs.lstatSync(orchestratorRoot).isDirectory()) return;

            previewAffectedFiles.push(resolveBundleName() + '/');
            const keepRuntime = keepRuntimeArtifactsValue;
            const runtimePath = path.join(orchestratorRoot, 'runtime');

            if (keepRuntime && fs.existsSync(runtimePath) && fs.lstatSync(runtimePath).isDirectory()) {
                backupItem(runtimePath, path.join(resolveBundleName(), 'runtime'), true, true);
                preservedRuntimePath = path.join(getBackupRoot(), resolveBundleName(), 'runtime');
            }

            const projectMemoryPath = path.join(orchestratorRoot, 'live', 'docs', 'project-memory');
            if (keepRuntime && fs.existsSync(projectMemoryPath) && fs.lstatSync(projectMemoryPath).isDirectory()) {
                backupItem(projectMemoryPath, path.join(resolveBundleName(), 'live', 'docs', 'project-memory'), true, true);
                preservedProjectMemoryPath = path.join(getBackupRoot(), resolveBundleName(), 'live', 'docs', 'project-memory');
            }

            if (!dryRun) {
                removePathRecursive(orchestratorRoot);
            }
            deletedDirectories++;
        }

        let canonicalEntrypoint = tryGetCanonicalEntrypointFromJsonFile(initAnswersCandidatePath, false);
        if (!canonicalEntrypoint) canonicalEntrypoint = tryGetCanonicalEntrypointFromJsonFile(liveVersionPath, true);
        if (!canonicalEntrypoint) canonicalEntrypoint = tryDetectCanonicalEntrypointFromManagedFiles(normalizedTarget, ENTRYPOINT_FILES);

        let detectedActiveAgentFiles: string[] = [];
        if (pathExists(initAnswersCandidatePath)) {
            detectedActiveAgentFiles = tryGetActiveAgentFilesFromJsonFile(initAnswersCandidatePath, null);
        }
        if (detectedActiveAgentFiles.length === 0 && pathExists(liveVersionPath)) {
            detectedActiveAgentFiles = tryGetActiveAgentFilesFromJsonFile(liveVersionPath, null);
        }
        if (detectedActiveAgentFiles.length === 0 && canonicalEntrypoint) {
            detectedActiveAgentFiles = [canonicalEntrypoint];
        }

        const qwenManagedEntries = [...new Set(['TASK.md', ...detectedActiveAgentFiles])].sort();

        let keepPrimaryEntrypointValue = false;
        if (canonicalEntrypoint && pathExists(path.join(normalizedTarget, canonicalEntrypoint))) {
            if (keepPrimaryEntrypoint !== undefined && keepPrimaryEntrypoint !== null && String(keepPrimaryEntrypoint).trim()) {
                keepPrimaryEntrypointValue = parseBooleanAnswer(keepPrimaryEntrypoint, 'KeepPrimaryEntrypoint');
            }
        }

        let keepTaskFileValue = false;
        const taskPath = path.join(normalizedTarget, 'TASK.md');
        if (pathExists(taskPath)) {
            if (keepTaskFile !== undefined && keepTaskFile !== null && String(keepTaskFile).trim()) {
                keepTaskFileValue = parseBooleanAnswer(keepTaskFile, 'KeepTaskFile');
            }
        }

        let keepRuntimeArtifactsValue = false;
        const runtimePath = path.join(orchestratorRoot, 'runtime');
        if (pathExists(runtimePath)) {
            if (keepRuntimeArtifacts !== undefined && keepRuntimeArtifacts !== null && String(keepRuntimeArtifacts).trim()) {
                keepRuntimeArtifactsValue = parseBooleanAnswer(keepRuntimeArtifacts, 'KeepRuntimeArtifacts');
            }
        }

        if (skipBackups) {
            warnings.push('--skip-backups active: no user-facing backup will be created. Recovery after successful completion is not possible.');
            if (!keepRuntimeArtifactsValue) {
                warnings.push('--skip-backups with keepRuntimeArtifacts=no: runtime artifacts (reports, logs, rollback snapshots) will be permanently deleted.');
            }
        }

        if (!dryRun) {
            currentPhase = 'SNAPSHOT';
            rollbackSnapshotPath = path.join(journalRoot, timestamp);
            rollbackRecords = createRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, getUninstallRollbackItems());
            writeRollbackRecords(rollbackSnapshotPath, rollbackRecords);

            currentPhase = 'SENTINEL';
            writeUninstallSentinel(normalizedTarget, {
                startedAt: new Date().toISOString(),
                operation: 'uninstall',
                rollbackSnapshotPath,
                timestamp,
                skipBackups,
                keepPrimaryEntrypoint: keepPrimaryEntrypointValue,
                keepTaskFile: keepTaskFileValue,
                keepRuntimeArtifacts: keepRuntimeArtifactsValue
            });
        }

        try {
            currentPhase = 'CLEANUP_FILES';

            if (!keepTaskFileValue) {
                if (!restoreItemFromInitializationBackup('TASK.md')) {
                    removeManagedFile('TASK.md');
                }
            }

            for (const rel of ENTRYPOINT_FILES) {
                if (keepPrimaryEntrypointValue && canonicalEntrypoint && rel.toLowerCase() === canonicalEntrypoint.toLowerCase()) {
                    continue;
                }
                if (!restoreItemFromInitializationBackup(rel)) {
                    removeManagedFile(rel);
                }
            }

            for (const rel of [...PROVIDER_AGENT_FILES, ...GITHUB_SKILL_BRIDGE_FILES]) {
                if (!restoreItemFromInitializationBackup(rel)) {
                    removeManagedFile(rel);
                }
            }

            if (!restoreItemFromInitializationBackup(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH)) {
                removeManagedFile(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
            }

            if (!restoreItemFromInitializationBackup(QWEN_SETTINGS_RELATIVE)) {
                cleanupQwenSettings(qwenManagedEntries);
            }
            if (!restoreItemFromInitializationBackup(CLAUDE_LOCAL_SETTINGS_RELATIVE)) {
                cleanupClaudeLocalSettings();
            }
            if (!restoreItemFromInitializationBackup(PRE_COMMIT_HOOK_RELATIVE)) {
                cleanupCommitGuardHook();
            }
            if (!restoreItemFromInitializationBackup('.gitignore')) {
                cleanupGitignore();
            }
            ensureUninstallBackupGitignoreEntries();

            if (options._testHooks && typeof options._testHooks.afterFileCleanup === 'function') {
                options._testHooks.afterFileCleanup();
            }

            currentPhase = 'CLEANUP_BUNDLE';
            removeBundleDirectory();
            currentPhase = 'FINALIZE';
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            if (!dryRun && rollbackSnapshotPath && rollbackRecords.length > 0) {
                try {
                    restoreRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackRecords);
                    rollbackStatus = 'RESTORED';
                } catch (rollbackError: unknown) {
                    const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    rollbackStatus = `FAILED: ${rollbackMsg}`;
                    throw new Error(
                        `Uninstall failed during ${currentPhase}. Original error: ${errorMessage}. ` +
                        `Rollback also failed: ${rollbackMsg}. Journal preserved at: ${rollbackSnapshotPath}`
                    );
                }
                removeUninstallSentinel(normalizedTarget);
                removePathRecursive(journalRoot);

                throw new Error(
                    `Uninstall failed during ${currentPhase} and workspace was restored to pre-uninstall state. ` +
                    `Error: ${errorMessage}`
                );
            }
            throw error;
        }

        if (!dryRun) {
            removeUninstallSentinel(normalizedTarget);
            removePathRecursive(journalRoot);
            rollbackStatus = 'NOT_TRIGGERED';
        }

        return {
            targetRoot: normalizedTarget,
            orchestratorRoot,
            initAnswersPath: initAnswersCandidatePath,
            initializationBackupRoot: initBackupRoot || '<none>',
            canonicalEntrypoint: canonicalEntrypoint || '<unknown>',
            keepPrimaryEntrypoint: keepPrimaryEntrypointValue,
            keepTaskFile: keepTaskFileValue,
            keepRuntimeArtifacts: keepRuntimeArtifactsValue,
            dryRun,
            skipBackups,
            backupRoot: backupRoot || '<none>',
            preservedRuntimePath: preservedRuntimePath || '<none>',
            preservedProjectMemoryPath: preservedProjectMemoryPath || '<none>',
            filesUpdated: updatedFiles,
            filesDeleted: deletedFiles,
            filesRestored: restoredFiles,
            directoriesDeleted: deletedDirectories,
            itemsBackedUp,
            rollbackStatus,
            warningsCount: warnings.length,
            warnings,
            result: dryRun ? 'DRY_RUN' : 'SUCCESS',
            previewAffectedFiles: dryRun ? [...new Set(previewAffectedFiles)] : []
        };
    });
}
