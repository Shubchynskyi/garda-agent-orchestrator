import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES
} from '../core/constants';
import { getProviderBridgeRelativePaths } from '../core/provider-registry';
import { pathExists, readTextFile } from '../core/filesystem';
import { detectLineEnding } from '../core/line-endings';
import { readJsonFile } from '../core/json';
import {
    getActiveAgentEntrypointFiles,
    getCanonicalEntrypointFile,
    getManagedGitignoreCleanupEntries,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../materialization/common';

type JsonObject = Record<string, unknown>;

interface EntrypointConfigJson extends JsonObject {
    CanonicalEntrypoint?: unknown;
    SourceOfTruth?: unknown;
    ActiveAgentFiles?: unknown;
}

interface InitializationBackupManifest extends JsonObject {
    PreExistingFiles?: unknown;
    preExistingFiles?: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ENTRYPOINT_FILES = Object.freeze([...ALL_AGENT_ENTRYPOINT_FILES]);

export const PROVIDER_AGENT_FILES = Object.freeze([...getProviderBridgeRelativePaths()]);

export const GITHUB_SKILL_BRIDGE_FILES = Object.freeze([
    '.github/agents/reviewer.md',
    '.github/agents/code-review.md',
    '.github/agents/db-review.md',
    '.github/agents/security-review.md',
    '.github/agents/refactor-review.md',
    '.github/agents/api-review.md',
    '.github/agents/test-review.md',
    '.github/agents/performance-review.md',
    '.github/agents/infra-review.md',
    '.github/agents/dependency-review.md'
]);

export const QWEN_SETTINGS_RELATIVE = '.qwen/settings.json';
export const CLAUDE_LOCAL_SETTINGS_RELATIVE = '.claude/settings.local.json';
export const PRE_COMMIT_HOOK_RELATIVE = '.git/hooks/pre-commit';
export const GITIGNORE_MANAGED_ENTRIES = Object.freeze(getManagedGitignoreCleanupEntries(true));

export function parseBooleanAnswer(value: unknown, fieldName: string): boolean {
    if (value === true) return true;
    if (value === false) return false;
    const normalized = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(normalized)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(normalized)) return false;
    throw new Error(`${fieldName} must be one of: true, false, yes, no, 1, 0.`);
}

function getCanonicalEntrypointFromSourceOfTruth(sourceOfTruthValue: unknown): string | null {
    if (!sourceOfTruthValue || !String(sourceOfTruthValue).trim()) return null;
    try {
        return getCanonicalEntrypointFile(String(sourceOfTruthValue));
    } catch {
        return null;
    }
}

export function tryGetCanonicalEntrypointFromJsonFile(filePath: string, preferCanonicalProperty: boolean): string | null {
    if (!pathExists(filePath)) return null;
    let payload: unknown;
    try { payload = readJsonFile(filePath); } catch { return null; }
    if (!isJsonObject(payload)) return null;

    const config = payload as EntrypointConfigJson;

    if (preferCanonicalProperty && config.CanonicalEntrypoint) {
        const canonical = String(config.CanonicalEntrypoint).trim();
        if (canonical) return canonical;
    }

    if (config.SourceOfTruth) {
        return getCanonicalEntrypointFromSourceOfTruth(String(config.SourceOfTruth));
    }
    return null;
}

export function tryGetActiveAgentFilesFromJsonFile(filePath: string, fallbackSourceOfTruth: string | null): string[] {
    if (!pathExists(filePath)) return [];
    let payload: unknown;
    try { payload = readJsonFile(filePath); } catch { return []; }
    if (!isJsonObject(payload)) return [];

    const config = payload as EntrypointConfigJson;
    const activeAgentFilesRaw = config.ActiveAgentFiles
        ? String(config.ActiveAgentFiles).trim() || null
        : null;

    const sourceOfTruth = config.SourceOfTruth
        ? String(config.SourceOfTruth)
        : fallbackSourceOfTruth || null;

    return getActiveAgentEntrypointFiles(activeAgentFilesRaw, sourceOfTruth);
}

export function tryDetectCanonicalEntrypointFromManagedFiles(targetRoot: string, entrypointFiles: readonly string[]): string | null {
    for (const rel of entrypointFiles) {
        const candidatePath = path.join(targetRoot, rel);
        if (!pathExists(candidatePath)) continue;
        const content = readTextFile(candidatePath);
        if (!content.trim()) continue;
        if (content.includes('Garda Agent Orchestrator Rule Index') || content.includes('## Rule Routing')) {
            return rel;
        }
    }
    return null;
}

export function normalizeTextAfterManagedBlockRemoval(content: string): string {
    if (!content) return '';
    const eol = detectLineEnding(content);
    let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    normalized = normalized.replace(/\n{3,}/g, '\n\n');
    const trimmed = normalized.trim();
    if (!trimmed) return '';
    return trimmed.split('\n').join(eol);
}

export function removeEmptyDirectoriesUpwards(startDirectory: string, targetRoot: string, dryRun: boolean): number {
    let current = startDirectory;
    let deletedCount = 0;
    const normalizedRoot = path.resolve(targetRoot).toLowerCase();

    while (current) {
        const normalizedCurrent = path.resolve(current).toLowerCase();
        if (normalizedCurrent === normalizedRoot) break;

        if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) {
            current = path.dirname(current);
            continue;
        }

        if (fs.readdirSync(current).length > 0) {
            break;
        }

        if (!dryRun) {
            fs.rmdirSync(current);
        }
        deletedCount++;
        current = path.dirname(current);
    }

    return deletedCount;
}

export function getInitializationBackupRoot(orchestratorRoot: string): string | null {
    const installBackupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    if (!pathExists(installBackupsRoot)) return null;

    const dirs = fs.readdirSync(installBackupsRoot, { withFileTypes: true })
        .filter((entry: fs.Dirent) => entry.isDirectory())
        .map((entry: fs.Dirent) => entry.name)
        .sort();

    if (dirs.length === 0) return null;
    return path.join(installBackupsRoot, dirs[0]);
}

export function getInitializationBackupManifest(backupRoot: string | null): InitializationBackupManifest | null {
    if (!backupRoot) return null;
    const manifestPath = path.join(backupRoot, '_install-backup.manifest.json');
    if (!pathExists(manifestPath)) return null;
    try {
        const manifest = readJsonFile(manifestPath);
        return isJsonObject(manifest) ? manifest as InitializationBackupManifest : null;
    } catch {
        return null;
    }
}

function isManagedOnlyBackupContent(backupPath: string, managedStart: string, managedEnd: string): boolean {
    if (!pathExists(backupPath)) return false;
    const content = readTextFile(backupPath);
    if (!content.trim()) return false;

    const pattern = new RegExp(escapeRegex(managedStart) + '[\\s\\S]*?' + escapeRegex(managedEnd), '');
    if (!pattern.test(content)) return false;

    const withoutBlock = content.replace(pattern, '');
    return normalizeTextAfterManagedBlockRemoval(withoutBlock) === '';
}

export function shouldRestoreItemFromInitializationBackup(
    relativePath: string,
    backupPath: string,
    initBackupManifest: InitializationBackupManifest | null,
    managedStart: string,
    managedEnd: string
): boolean {
    if (initBackupManifest) {
        const preExistingFiles = initBackupManifest.PreExistingFiles || initBackupManifest.preExistingFiles;
        if (Array.isArray(preExistingFiles)) {
            const normalizedRel = relativePath.replace(/\//g, '\\');
            for (const item of preExistingFiles) {
                if (!item) continue;
                const candidate = String(item).replace(/\//g, '\\');
                if (candidate.toLowerCase() === normalizedRel.toLowerCase()) return true;
            }
            return false;
        }
    }
    return !isManagedOnlyBackupContent(backupPath, managedStart, managedEnd);
}

export function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function arrayContainsPath(items: readonly string[], relativePath: string): boolean {
    const normalizedTarget = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
    return items.some((item) => String(item || '').replace(/\\/g, '/').toLowerCase() === normalizedTarget);
}

export function looksLikeManagedFileWithoutMarkers(relativePath: string, content: string): boolean {
    const text = String(content || '');
    if (!text.trim()) return false;

    if (arrayContainsPath(ENTRYPOINT_FILES, relativePath)) {
        if (text.includes('Garda Agent Orchestrator Rule Index') && text.includes('## Rule Routing')) {
            return true;
        }
        if (text.includes('This file is a redirect.') && text.includes('Canonical source of truth for agent workflow rules:')) {
            return true;
        }
    }

    if (String(relativePath || '').replace(/\\/g, '/').toLowerCase() === 'task.md') {
        if (text.includes('Single-file task queue for local agent orchestration.') && text.includes('## Active Queue')) {
            return true;
        }
    }

    if (arrayContainsPath(PROVIDER_AGENT_FILES, relativePath)) {
        if (text.includes('Canonical source of truth for agent workflow rules:') && text.includes('## Required Execution Contract')) {
            return true;
        }
    }

    if (arrayContainsPath(GITHUB_SKILL_BRIDGE_FILES, relativePath)) {
        if (text.includes('Canonical source of truth for agent workflow rules:') && text.includes('## Skill Bridge Contract')) {
            return true;
        }
    }

    const normalizedRelPath = String(relativePath || '').replace(/\\/g, '/');
    if (normalizedRelPath.toLowerCase() === SHARED_START_TASK_WORKFLOW_RELATIVE_PATH.toLowerCase()) {
        if (text.includes('Mandatory shared router for any task execution through Garda orchestration.')) {
            return true;
        }
    }

    return false;
}

export function getUninstallRollbackItems(): string[] {
    return [
        'TASK.md',
        ...ENTRYPOINT_FILES,
        ...PROVIDER_AGENT_FILES,
        ...GITHUB_SKILL_BRIDGE_FILES,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        QWEN_SETTINGS_RELATIVE,
        CLAUDE_LOCAL_SETTINGS_RELATIVE,
        PRE_COMMIT_HOOK_RELATIVE,
        '.gitignore'
    ];
}
