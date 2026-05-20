import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES, resolveBundleNameForTarget } from '../core/constants';
import { ensureDirectory, pathExists, readTextFile } from '../core/filesystem';
import { readJsonFile, writeJsonFile } from '../core/json';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { validateInitAnswers } from '../schemas/init-answers';
import {
    getActiveAgentEntrypointFiles,
    getCanonicalEntrypointFile,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from './common';
import {
    MANAGED_END,
    MANAGED_START
} from './content-builders';

const SWITCH_AGENTIGNORE_COMMENT = '# Garda off-mode agent ignore';

export type SwitchMode = 'on' | 'off';

export interface RunSwitchModeOptions {
    targetRoot: string;
    mode: SwitchMode;
    dryRun?: boolean;
}

export interface SwitchModeResult extends Record<string, unknown> {
    mode: SwitchMode;
    targetRoot: string;
    bundleRoot: string;
    storageRoot: string;
    dryRun: boolean;
    movedToInactive: number;
    movedToRoot: number;
    agentIgnoreUpdated: boolean;
    conflicts: number;
    status: 'UPDATED' | 'NO_CHANGE' | 'BLOCKED';
}

interface SwitchPlanAction {
    type: 'move-root-to-off' | 'restore-root-from-off' | 'move-root-to-on' | 'restore-root-from-on' | 'write-agentignore' | 'remove-agentignore';
    relativePath: string;
    rootPath: string;
    storagePath?: string;
    content?: string;
}

interface SwitchPlan {
    actions: SwitchPlanAction[];
    conflicts: string[];
}

interface SwitchManifestEntry {
    relative_path: string;
    sha256: string;
}

interface SwitchStateSnapshot {
    mode: SwitchMode | null;
    offStorageHashes: Map<string, string>;
    onStorageHashes: Map<string, string>;
}

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
}

function isManagedContent(content: string): boolean {
    return content.includes(MANAGED_START) && content.includes(MANAGED_END);
}

function sha256(content: Buffer | string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function readFileBuffer(filePath: string): Buffer {
    return fs.readFileSync(filePath);
}

function sameFileContent(firstPath: string, secondPath: string): boolean {
    if (!isRegularFile(firstPath) || !isRegularFile(secondPath)) {
        return false;
    }
    return sha256(readFileBuffer(firstPath)) === sha256(readFileBuffer(secondPath));
}

function isRegularFile(filePath: string): boolean {
    try {
        const stats = fs.lstatSync(filePath);
        return !stats.isSymbolicLink() && stats.isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function isSymbolicLink(filePath: string): boolean {
    try {
        return fs.lstatSync(filePath).isSymbolicLink();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function isInsideRoot(filePath: string, rootPath: string): boolean {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findSymlinkInExistingPath(filePath: string, rootPath: string): string | null {
    let current = path.resolve(filePath);
    const root = path.resolve(rootPath);
    while (isInsideRoot(current, root)) {
        if (isSymbolicLink(current)) {
            return current;
        }
        if (current === root) {
            return null;
        }
        current = path.dirname(current);
    }
    return null;
}

function assertSafeSwitchPath(filePath: string, rootPath: string): void {
    if (!isInsideRoot(filePath, rootPath)) {
        throw new Error(`GARDA_SWITCH_BLOCKED: path escapes switch boundary: ${filePath}`);
    }
    const symlinkPath = findSymlinkInExistingPath(filePath, rootPath);
    if (symlinkPath) {
        throw new Error(`GARDA_SWITCH_BLOCKED: symbolic link in switch path: ${symlinkPath}`);
    }
}

function pushUnsafePathConflict(
    plan: SwitchPlan,
    relativePath: string,
    label: string,
    filePath: string,
    rootPath: string
): boolean {
    if (!isInsideRoot(filePath, rootPath)) {
        plan.conflicts.push(`${relativePath}: ${label} escapes switch boundary at ${filePath}`);
        return true;
    }
    const symlinkPath = findSymlinkInExistingPath(filePath, rootPath);
    if (symlinkPath) {
        plan.conflicts.push(`${relativePath}: ${label} contains symbolic link at ${symlinkPath}`);
        return true;
    }
    return false;
}

function removeEmptyParents(startDir: string, rootDir: string): void {
    let current = path.resolve(startDir);
    const root = path.resolve(rootDir);
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

function moveFile(sourcePath: string, targetPath: string, sourceRoot: string, targetRoot: string, rootForCleanup: string): void {
    assertSafeSwitchPath(sourcePath, sourceRoot);
    assertSafeSwitchPath(targetPath, targetRoot);
    assertSafeSwitchPath(path.dirname(targetPath), targetRoot);
    ensureDirectory(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
    fs.rmSync(sourcePath, { force: true });
    removeEmptyParents(path.dirname(sourcePath), rootForCleanup);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildManagedBlockPattern(flags = 'm'): RegExp {
    return new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}`, flags);
}

function getSwitchAgentIgnoreBlockCount(content: string): number {
    return [...content.matchAll(buildManagedBlockPattern('gm'))]
        .filter((match) => match[0].includes(SWITCH_AGENTIGNORE_COMMENT))
        .length;
}

function removeSwitchAgentIgnoreBlockFromContent(content: string): string {
    const next = content
        .replace(buildManagedBlockPattern('gm'), (block) => block.includes(SWITCH_AGENTIGNORE_COMMENT) ? '' : block)
        .trim();
    if (!next) {
        return '';
    }
    return `${next}${content.includes('\r\n') ? '\r\n' : '\n'}`;
}

function buildAgentIgnoreContent(existingContent: string | null, bundleName: string): string {
    const block = [
        MANAGED_START,
        SWITCH_AGENTIGNORE_COMMENT,
        `${bundleName}/`,
        MANAGED_END
    ].join('\n');
    if (!existingContent || !existingContent.trim()) {
        return `${block}\n`;
    }
    if (getSwitchAgentIgnoreBlockCount(existingContent) === 1) {
        return existingContent.replace(
            buildManagedBlockPattern('gm'),
            (existingBlock) => existingBlock.includes(SWITCH_AGENTIGNORE_COMMENT) ? block : existingBlock
        );
    }
    const newline = existingContent.includes('\r\n') ? '\r\n' : '\n';
    const prefix = existingContent.endsWith(newline) ? existingContent : `${existingContent}${newline}`;
    return `${prefix}${block}${newline}`;
}

function hasIncompleteManagedMarkers(content: string): boolean {
    return content.split(MANAGED_START).length !== content.split(MANAGED_END).length;
}

function readActiveEntrypoints(targetRoot: string, bundleRoot: string): string[] {
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    if (!pathExists(initAnswersPath)) {
        throw new Error(`Init answers file not found: ${initAnswersPath}`);
    }
    const initAnswers = validateInitAnswers(readJsonFile(initAnswersPath));
    const canonicalEntryFile = getCanonicalEntrypointFile(initAnswers.SourceOfTruth);
    const activeEntryFilesSeed = initAnswers.ActiveAgentFiles
        ? initAnswers.ActiveAgentFiles.join(', ')
        : null;
    const activeEntryFiles = getActiveAgentEntrypointFiles(activeEntryFilesSeed, initAnswers.SourceOfTruth);
    return activeEntryFiles.length > 0 ? activeEntryFiles : [canonicalEntryFile];
}

function addManagedRootEntrypointCandidates(candidateSet: Set<string>, targetRoot: string): void {
    for (const entrypointFile of ALL_AGENT_ENTRYPOINT_FILES) {
        const entrypointPath = path.join(targetRoot, entrypointFile);
        if (!isRegularFile(entrypointPath)) {
            continue;
        }
        if (isManagedContent(readTextFile(entrypointPath))) {
            candidateSet.add(entrypointFile);
        }
    }
}

function addManagedStoredEntrypointCandidates(candidateSet: Set<string>, storageRoot: string): void {
    for (const entrypointFile of ALL_AGENT_ENTRYPOINT_FILES) {
        for (const storageName of ['off', 'on']) {
            const storagePath = path.join(storageRoot, storageName, entrypointFile);
            if (isRegularFile(storagePath) && isManagedContent(readTextFile(storagePath))) {
                candidateSet.add(entrypointFile);
            }
        }
    }
}

function getSwitchCandidatePaths(targetRoot: string, bundleRoot: string): string[] {
    const activeEntryFiles = readActiveEntrypoints(targetRoot, bundleRoot);
    const storageRoot = path.join(bundleRoot, 'runtime', 'switch');
    const candidateSet = new Set<string>([
        ...activeEntryFiles,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
    ]);
    addManagedRootEntrypointCandidates(candidateSet, targetRoot);
    addManagedStoredEntrypointCandidates(candidateSet, storageRoot);
    const providerProfiles = getProviderOrchestratorProfileDefinitions().filter(
        (profile) => candidateSet.has(profile.entrypointFile)
    );
    for (const profile of providerProfiles) {
        candidateSet.add(profile.orchestratorRelativePath);
    }
    const reviewBridgeEntrypoint = '.github/copilot-instructions.md';
    if (activeEntryFiles.includes(reviewBridgeEntrypoint)) {
        for (const profile of getGitHubSkillBridgeProfileDefinitions()) {
            candidateSet.add(profile.relativePath);
        }
    }
    return [...candidateSet].map(normalizeRelativePath).sort();
}

function pushRootToStorageAction(
    plan: SwitchPlan,
    type: 'move-root-to-off' | 'move-root-to-on',
    relativePath: string,
    rootPath: string,
    storagePath: string,
    allowReplaceStorage = false
): void {
    if (pathExists(storagePath) && !sameFileContent(rootPath, storagePath) && !allowReplaceStorage) {
        plan.conflicts.push(`${relativePath}: storage already contains different content at ${storagePath}`);
        return;
    }
    if (pathExists(storagePath) && sameFileContent(rootPath, storagePath)) {
        plan.actions.push({ type, relativePath, rootPath, storagePath });
        return;
    }
    plan.actions.push({ type, relativePath, rootPath, storagePath });
}

function pushStorageToRootAction(
    plan: SwitchPlan,
    type: 'restore-root-from-off' | 'restore-root-from-on',
    relativePath: string,
    rootPath: string,
    storagePath: string,
    rootWillBeMoved = false
): void {
    if (!pathExists(storagePath)) {
        return;
    }
    if (pathExists(rootPath) && !rootWillBeMoved) {
        if (sameFileContent(rootPath, storagePath)) {
            return;
        }
        plan.conflicts.push(`${relativePath}: root file exists and differs from stored switch file`);
        return;
    }
    plan.actions.push({ type, relativePath, rootPath, storagePath });
}

function canRestoreStorageToRoot(rootPath: string, storagePath: string, rootWillBeMoved = false): boolean {
    if (!pathExists(storagePath)) {
        return false;
    }
    return !pathExists(rootPath) || rootWillBeMoved || sameFileContent(rootPath, storagePath);
}

function buildManifestHashMap(value: unknown): Map<string, string> {
    const hashes = new Map<string, string>();
    if (!Array.isArray(value)) {
        return hashes;
    }
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.relative_path === 'string' && typeof candidate.sha256 === 'string') {
            hashes.set(normalizeRelativePath(candidate.relative_path), candidate.sha256);
        }
    }
    return hashes;
}

function readSwitchStateSnapshot(storageRoot: string): SwitchStateSnapshot {
    const statePath = path.join(storageRoot, 'state.json');
    if (!pathExists(statePath)) {
        return {
            mode: null,
            offStorageHashes: new Map(),
            onStorageHashes: new Map()
        };
    }
    try {
        const parsed = readJsonFile(statePath) as Record<string, unknown>;
        return {
            mode: parsed.mode === 'on' || parsed.mode === 'off' ? parsed.mode : null,
            offStorageHashes: buildManifestHashMap(parsed.off_storage_files),
            onStorageHashes: buildManifestHashMap(parsed.on_storage_files)
        };
    } catch {
        return {
            mode: null,
            offStorageHashes: new Map(),
            onStorageHashes: new Map()
        };
    }
}

function getExpectedStorageHash(state: SwitchStateSnapshot, storageKind: 'off' | 'on', relativePath: string): string | null {
    const manifest = storageKind === 'off' ? state.offStorageHashes : state.onStorageHashes;
    return manifest.get(normalizeRelativePath(relativePath)) || null;
}

function pushStorageIntegrityConflict(
    plan: SwitchPlan,
    state: SwitchStateSnapshot,
    storageKind: 'off' | 'on',
    relativePath: string,
    storagePath: string
): boolean {
    if (!pathExists(storagePath)) {
        return false;
    }
    const expectedHash = getExpectedStorageHash(state, storageKind, relativePath);
    if (!expectedHash) {
        plan.conflicts.push(`${relativePath}: ${storageKind} storage file has no switch-state integrity manifest entry`);
        return true;
    }
    if (sha256(readFileBuffer(storagePath)) !== expectedHash) {
        plan.conflicts.push(`${relativePath}: ${storageKind} storage file hash does not match switch-state integrity manifest`);
        return true;
    }
    return false;
}

function buildSwitchPlan(options: {
    mode: SwitchMode;
    targetRoot: string;
    bundleRoot: string;
    storageRoot: string;
    candidates: string[];
    state: SwitchStateSnapshot;
}): SwitchPlan {
    const plan: SwitchPlan = { actions: [], conflicts: [] };
    const { mode, targetRoot, bundleRoot, storageRoot, candidates, state } = options;
    const offRoot = path.join(storageRoot, 'off');
    const onRoot = path.join(storageRoot, 'on');

    for (const relativePath of candidates) {
        const rootPath = path.join(targetRoot, relativePath);
        const offPath = path.join(offRoot, relativePath);
        const onPath = path.join(onRoot, relativePath);
        let candidateUnsafe = false;
        for (const [label, candidatePath] of [
            ['root file', rootPath],
            ['off storage file', offPath],
            ['on storage file', onPath]
        ] as const) {
            if (pushUnsafePathConflict(plan, relativePath, label, candidatePath, targetRoot)) {
                candidateUnsafe = true;
            }
        }
        if (candidateUnsafe) {
            continue;
        }
        const rootExists = isRegularFile(rootPath);
        const rootContent = rootExists ? readTextFile(rootPath) : null;
        const rootManaged = rootContent !== null && isManagedContent(rootContent);

        if (mode === 'off') {
            const rootWillBeMoved = rootExists && rootManaged;
            if (rootExists && rootManaged) {
                pushRootToStorageAction(plan, 'move-root-to-off', relativePath, rootPath, offPath, true);
            }
            if (!pushStorageIntegrityConflict(plan, state, 'on', relativePath, onPath)) {
                pushStorageToRootAction(plan, 'restore-root-from-on', relativePath, rootPath, onPath, rootWillBeMoved);
            }
            continue;
        }

        const canRestoreManagedRoot = canRestoreStorageToRoot(rootPath, offPath, rootExists && !rootManaged);
        const rootWillBeMoved = rootExists && !rootManaged && canRestoreManagedRoot;
        if (rootExists && !rootManaged && canRestoreManagedRoot) {
            pushRootToStorageAction(plan, 'move-root-to-on', relativePath, rootPath, onPath);
        }
        if (!pushStorageIntegrityConflict(plan, state, 'off', relativePath, offPath)) {
            pushStorageToRootAction(plan, 'restore-root-from-off', relativePath, rootPath, offPath, rootWillBeMoved);
        }
    }

    const agentIgnorePath = path.join(targetRoot, '.agentignore');
    if (pushUnsafePathConflict(plan, '.agentignore', 'root file', agentIgnorePath, targetRoot)) {
        return plan;
    }
    const existingAgentIgnore = pathExists(agentIgnorePath) ? readTextFile(agentIgnorePath) : null;
    if (existingAgentIgnore && hasIncompleteManagedMarkers(existingAgentIgnore)) {
        plan.conflicts.push('.agentignore: managed block markers are incomplete');
        return plan;
    }
    const switchAgentIgnoreBlockCount = existingAgentIgnore ? getSwitchAgentIgnoreBlockCount(existingAgentIgnore) : 0;
    if (switchAgentIgnoreBlockCount > 1) {
        plan.conflicts.push('.agentignore: multiple Garda off-mode managed blocks found');
        return plan;
    }
    if (mode === 'off') {
        const nextContent = buildAgentIgnoreContent(existingAgentIgnore, path.basename(bundleRoot));
        if (nextContent !== (existingAgentIgnore || '')) {
            plan.actions.push({
                type: 'write-agentignore',
                relativePath: '.agentignore',
                rootPath: agentIgnorePath,
                content: nextContent
            });
        }
    } else if (existingAgentIgnore && switchAgentIgnoreBlockCount === 1) {
        const nextContent = removeSwitchAgentIgnoreBlockFromContent(existingAgentIgnore);
        plan.actions.push({
            type: 'remove-agentignore',
            relativePath: '.agentignore',
            rootPath: agentIgnorePath,
            content: nextContent
        });
    }

    return plan;
}

function executeSwitchPlan(plan: SwitchPlan, dryRun: boolean, targetRoot: string): {
    movedToInactive: number;
    movedToRoot: number;
    agentIgnoreUpdated: boolean;
} {
    let movedToInactive = 0;
    let movedToRoot = 0;
    let agentIgnoreUpdated = false;

    if (dryRun) {
        for (const action of plan.actions) {
            if (action.type === 'move-root-to-off' || action.type === 'move-root-to-on') movedToInactive++;
            if (action.type === 'restore-root-from-off' || action.type === 'restore-root-from-on') movedToRoot++;
            if (action.type === 'write-agentignore' || action.type === 'remove-agentignore') agentIgnoreUpdated = true;
        }
        return { movedToInactive, movedToRoot, agentIgnoreUpdated };
    }

    for (const action of plan.actions) {
        if (action.type === 'move-root-to-off' || action.type === 'move-root-to-on') {
            moveFile(action.rootPath, action.storagePath!, targetRoot, targetRoot, targetRoot);
            movedToInactive++;
        } else if (action.type === 'restore-root-from-off' || action.type === 'restore-root-from-on') {
            moveFile(action.storagePath!, action.rootPath, targetRoot, targetRoot, path.dirname(action.storagePath!));
            movedToRoot++;
        } else if (action.type === 'write-agentignore') {
            ensureDirectory(path.dirname(action.rootPath));
            fs.writeFileSync(action.rootPath, action.content || '', 'utf8');
            agentIgnoreUpdated = true;
        } else if (action.type === 'remove-agentignore') {
            if (action.content && action.content.trim()) {
                fs.writeFileSync(action.rootPath, action.content, 'utf8');
            } else {
                fs.rmSync(action.rootPath, { force: true });
            }
            agentIgnoreUpdated = true;
        }
    }

    return { movedToInactive, movedToRoot, agentIgnoreUpdated };
}

function buildManifestEntries(rootPath: string, candidates: string[]): SwitchManifestEntry[] {
    const entries: SwitchManifestEntry[] = [];
    for (const relativePath of candidates) {
        const filePath = path.join(rootPath, relativePath);
        if (isRegularFile(filePath)) {
            entries.push({
                relative_path: relativePath,
                sha256: sha256(readFileBuffer(filePath))
            });
        }
    }
    return entries;
}

export function readSwitchModeState(targetRoot: string, bundleRoot?: string): SwitchMode | null {
    const resolvedTargetRoot = path.resolve(targetRoot || '.');
    const resolvedBundleRoot = bundleRoot || path.join(resolvedTargetRoot, resolveBundleNameForTarget(resolvedTargetRoot));
    const statePath = path.join(resolvedBundleRoot, 'runtime', 'switch', 'state.json');
    if (!pathExists(statePath)) {
        return null;
    }
    try {
        const parsed = readJsonFile(statePath) as Record<string, unknown>;
        return parsed.mode === 'on' || parsed.mode === 'off' ? parsed.mode : null;
    } catch {
        return null;
    }
}

export function runSwitchMode(options: RunSwitchModeOptions): SwitchModeResult {
    const targetRoot = path.resolve(options.targetRoot || '.');
    const bundleRoot = path.join(targetRoot, resolveBundleNameForTarget(targetRoot));
    if (!pathExists(bundleRoot)) {
        throw new Error(`Deployed bundle not found: ${bundleRoot}`);
    }
    const storageRoot = path.join(bundleRoot, 'runtime', 'switch');
    const dryRun = options.dryRun === true;
    const candidates = getSwitchCandidatePaths(targetRoot, bundleRoot);
    const state = readSwitchStateSnapshot(storageRoot);
    const plan = buildSwitchPlan({
        mode: options.mode,
        targetRoot,
        bundleRoot,
        storageRoot,
        candidates,
        state
    });

    if (plan.conflicts.length > 0) {
        throw new Error([
            `GARDA_SWITCH_BLOCKED: ${options.mode}`,
            ...plan.conflicts.map((conflict) => `- ${conflict}`),
            'No files were changed. Resolve the conflicts or move the files manually, then rerun with --dry-run first.'
        ].join('\n'));
    }

    const execution = executeSwitchPlan(plan, dryRun, targetRoot);
    if (!dryRun) {
        ensureDirectory(storageRoot);
        writeJsonFile(path.join(storageRoot, 'state.json'), {
            schema_version: 1,
            mode: options.mode,
            updated_at_utc: new Date().toISOString(),
            candidates,
            root_files: buildManifestEntries(targetRoot, candidates),
            off_storage_files: buildManifestEntries(path.join(storageRoot, 'off'), candidates),
            on_storage_files: buildManifestEntries(path.join(storageRoot, 'on'), candidates)
        });
        writeProtectedControlPlaneManifest(targetRoot);
    }

    const status = plan.actions.length === 0 ? 'NO_CHANGE' : 'UPDATED';
    return {
        mode: options.mode,
        targetRoot,
        bundleRoot,
        storageRoot,
        dryRun,
        movedToInactive: execution.movedToInactive,
        movedToRoot: execution.movedToRoot,
        agentIgnoreUpdated: execution.agentIgnoreUpdated,
        conflicts: 0,
        status
    };
}
