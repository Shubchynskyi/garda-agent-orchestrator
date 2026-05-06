import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    LIFECYCLE_COMMANDS,
    resolveBundleName
} from '../../core/constants';
import { formatManifestResult, formatVerifyResult, runVerify, validateManifest } from '../../validators';
import { runContractMigrations } from '../../lifecycle/contract-migrations';
import { collectUpdateAnnouncements } from '../../lifecycle/update-announcements';
import { runUpdate } from '../../lifecycle/update';
import { type CheckUpdateRunnerOptions } from '../../lifecycle/check-update';
import { getBundlePath } from './cli-helpers';

export type ParsedOptionValue = string | boolean | string[] | undefined;
export type ParsedOptionsRecord = Record<string, ParsedOptionValue>;

export interface UpdateLifecycleResult extends Record<string, unknown> {
    previousVersion?: unknown;
    updatedVersion?: unknown;
    workflowConfigMergeStatus?: unknown;
    projectMemoryMaintenanceSummaryLine?: unknown;
    projectMemoryRefreshHandoffPrompt?: unknown;
    rollbackSnapshotPath?: unknown;
    rollbackStatus?: unknown;
    updateReportPath?: unknown;
    requestedPackageSpec?: unknown;
    exactPackageSpec?: unknown;
    resolvedPackageVersion?: unknown;
    resolvedPackageIntegrity?: unknown;
    updateMessages?: unknown;
    releaseNotes?: unknown;
    updateAnnouncementWarnings?: unknown;
}

export class ValidationFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationFailureError';
        Object.setPrototypeOf(this, ValidationFailureError.prototype);
    }
}

export class GateFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GateFailureError';
        Object.setPrototypeOf(this, GateFailureError.prototype);
    }
}

export function countStoragePolicyActions(storagePolicyResult: { removed: string[]; compressed: string[] } | undefined): number {
    if (!storagePolicyResult) {
        return 0;
    }
    return storagePolicyResult.removed.length + storagePolicyResult.compressed.length;
}

export function getPackageRoot(): string {
    return path.resolve(__dirname, '..', '..', '..', '..');
}

export function requireResolvedPath(resolvedPath: string | null, label: string): string {
    if (!resolvedPath) {
        throw new Error(`${label} must not be empty.`);
    }
    return resolvedPath;
}

export function removeArtifactIfExists(filePath: string | null | undefined): void {
    if (!filePath) {
        return;
    }
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            fs.rmSync(filePath, { force: true });
        }
    } catch {
        // Best-effort cleanup only. The original failure should surface.
    }
}

export function toKeyValueRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

export function buildKeyValueOutputLines(obj: Record<string, unknown> | null | undefined, keys: string[]): string[] {
    const lines: string[] = [];
    if (!obj) {
        return lines;
    }
    for (const key of keys) {
        if (obj[key] === undefined) {
            continue;
        }
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        const value = typeof obj[key] === 'boolean'
            ? (obj[key] ? 'True' : 'False')
            : String(obj[key]);
        lines.push(`${label}: ${value}`);
    }
    return lines;
}

export function formatKeyValueOutput(obj: Record<string, unknown> | null | undefined, keys: string[]): void {
    for (const line of buildKeyValueOutputLines(obj, keys)) {
        console.log(line);
    }
}

function toPrintableLines(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.length > 0);
}

function printAnnouncementSection(title: string, lines: string[]): void {
    if (lines.length === 0) {
        return;
    }
    console.log('');
    console.log(`${title}:`);
    for (const line of lines) {
        console.log(line);
    }
}

export function printUpdateAnnouncementSections(result: Record<string, unknown> | null | undefined): void {
    if (!result) {
        return;
    }

    const updateMessages = Array.isArray(result.updateMessages)
        ? result.updateMessages as Array<Record<string, unknown>>
        : [];
    const releaseNotes = Array.isArray(result.releaseNotes)
        ? result.releaseNotes as Array<Record<string, unknown>>
        : [];
    const warnings = toPrintableLines(result.updateAnnouncementWarnings);

    const updateMessageLines = updateMessages.flatMap((entry) => {
        const version = String(entry.version ?? '').trim();
        const title = String(entry.title ?? '').trim();
        const body = toPrintableLines(entry.body);
        if (!version || !title) {
            return [];
        }
        return [
            `- ${version}: ${title}`,
            ...body.map((line) => `  ${line}`)
        ];
    });
    const releaseNoteLines = releaseNotes.flatMap((entry) => {
        const version = String(entry.version ?? '').trim();
        const lines = toPrintableLines(entry.lines);
        if (!version || lines.length === 0) {
            return [];
        }
        return [
            `- ${version}`,
            ...lines.map((line) => `  ${line}`)
        ];
    });

    printAnnouncementSection('UpdateMessages', updateMessageLines);
    printAnnouncementSection('ReleaseNotes', releaseNoteLines);
    printAnnouncementSection('UpdateAnnouncementWarnings', warnings.map((line) => `- ${line}`));
}

export function normalizeYesNo(value: unknown, label: string): string {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) {
        throw new Error(`${label} must not be empty.`);
    }
    if (text === 'true') {
        return 'yes';
    }
    if (text === 'false') {
        return 'no';
    }
    if (text !== 'yes' && text !== 'no') {
        throw new Error(`${label} must be one of: yes, no (legacy true/false also accepted).`);
    }
    return text;
}

export function getCommandName(argv: string[]): string {
    if (argv.length === 0) {
        return 'bootstrap';
    }
    const candidate = String(argv[0] || '').trim();
    if (candidate === 'help') {
        return 'help';
    }
    if (candidate === 'gate' || LIFECYCLE_COMMANDS.includes(candidate)) {
        return candidate;
    }
    return 'bootstrap';
}

export function ensureBundleExists(targetRoot: string, commandName: string): string {
    const bundlePath = getBundlePath(targetRoot);
    if (!fs.existsSync(bundlePath) || !fs.lstatSync(bundlePath).isDirectory()) {
        throw new Error([
            `Deployed bundle not found: ${bundlePath}`,
            `Run 'npx garda-agent-orchestrator' first, then rerun '${commandName}'.`
        ].join('\n'));
    }
    process.env.GARDA_BUNDLE_NAME = path.basename(bundlePath);
    return bundlePath;
}

export function getDefaultInitAnswersPath(targetRoot: string, bundlePath?: string): string {
    const effectiveBundlePath = bundlePath || getBundlePath(targetRoot);
    return path.join(path.basename(effectiveBundlePath), 'runtime', 'init-answers.json');
}

interface CachedRuntimeModule {
    id: string;
    children: CachedRuntimeModule[];
}

function normalizeModuleCachePath(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32'
        ? resolvedPath.toLowerCase()
        : resolvedPath;
}

function getBundleRuntimeRoot(bundlePath: string): string {
    return path.join(path.resolve(bundlePath), 'dist', 'src');
}

function isBundleRuntimeModulePath(filePath: string, runtimeRoot: string): boolean {
    const normalizedFilePath = normalizeModuleCachePath(filePath);
    const normalizedRuntimeRoot = normalizeModuleCachePath(runtimeRoot);
    return normalizedFilePath === normalizedRuntimeRoot
        || normalizedFilePath.startsWith(`${normalizedRuntimeRoot}${path.sep}`);
}

function collectReachableCachedRuntimeModules(
    entryModulePaths: string[],
    runtimeRoot: string
): string[] {
    const visited = new Set<string>();
    const toInvalidate = new Set<string>();
    const queue: CachedRuntimeModule[] = [];

    for (const entryModulePath of entryModulePaths) {
        try {
            const resolvedEntryPath = require.resolve(entryModulePath);
            const cachedModule = require.cache[resolvedEntryPath] as CachedRuntimeModule | undefined;
            if (cachedModule) {
                queue.push(cachedModule);
            }
        } catch {
            // ignore cache miss
        }
    }

    while (queue.length > 0) {
        const currentModule = queue.pop();
        if (!currentModule) {
            continue;
        }
        if (visited.has(currentModule.id)) {
            continue;
        }
        visited.add(currentModule.id);

        if (!isBundleRuntimeModulePath(currentModule.id, runtimeRoot)) {
            continue;
        }

        toInvalidate.add(path.resolve(currentModule.id));
        for (const childModule of currentModule.children) {
            if (!visited.has(childModule.id)) {
                queue.push(childModule);
            }
        }
    }

    return Array.from(toInvalidate).sort();
}

export function invalidateBundleRuntimeModuleCache(bundlePath: string, entryModulePaths?: string[]): string[] {
    const runtimeRoot = getBundleRuntimeRoot(bundlePath);
    if (!fs.existsSync(runtimeRoot)) {
        return [];
    }

    const invalidatedPaths = entryModulePaths && entryModulePaths.length > 0
        ? collectReachableCachedRuntimeModules(entryModulePaths, runtimeRoot)
        : Object.keys(require.cache)
            .filter((cachedPath) => isBundleRuntimeModulePath(cachedPath, runtimeRoot))
            .map((cachedPath) => path.resolve(cachedPath))
            .sort();

    for (const invalidatedPath of invalidatedPaths) {
        delete require.cache[invalidatedPath];
    }

    return invalidatedPaths;
}

export function buildUpdateLifecycleRunner(bundlePath: string, fallbackDryRun: boolean | undefined) {
    return function runLifecycleFromCli(runnerOptions: CheckUpdateRunnerOptions): UpdateLifecycleResult {
        const bundleResolved = path.resolve(bundlePath);
        const targetUpdateModulePath = path.join(bundleResolved, 'dist', 'src', 'lifecycle', 'update.js');
        const targetMigrationModulePath = path.join(bundleResolved, 'dist', 'src', 'lifecycle', 'contract-migrations.js');
        const targetVerifyModulePath = path.join(bundleResolved, 'dist', 'src', 'validators', 'verify.js');
        const targetManifestModulePath = path.join(bundleResolved, 'dist', 'src', 'validators', 'validate-manifest.js');

        let effectiveRunUpdate = runUpdate;
        let effectiveRunContractMigrations = runContractMigrations;
        let effectiveRunVerify = runVerify;
        let effectiveValidateManifest = validateManifest;

        if (fs.existsSync(targetUpdateModulePath)) {
            try {
                invalidateBundleRuntimeModuleCache(bundlePath, [
                    targetUpdateModulePath,
                    targetMigrationModulePath,
                    targetVerifyModulePath,
                    targetManifestModulePath
                ]);

                const newUpdateModule = require(targetUpdateModulePath);
                if (typeof newUpdateModule.runUpdate === 'function') {
                    effectiveRunUpdate = newUpdateModule.runUpdate;
                }
                const newMigrationModule = fs.existsSync(targetMigrationModulePath) ? require(targetMigrationModulePath) : null;
                if (newMigrationModule && typeof newMigrationModule.runContractMigrations === 'function') {
                    effectiveRunContractMigrations = newMigrationModule.runContractMigrations;
                }
                const newVerifyModule = fs.existsSync(targetVerifyModulePath) ? require(targetVerifyModulePath) : null;
                if (newVerifyModule && typeof newVerifyModule.runVerify === 'function') {
                    effectiveRunVerify = newVerifyModule.runVerify;
                }
                const newManifestModule = fs.existsSync(targetManifestModulePath) ? require(targetManifestModulePath) : null;
                if (newManifestModule && typeof newManifestModule.validateManifest === 'function') {
                    effectiveValidateManifest = newManifestModule.validateManifest;
                }
            } catch {
                // Fallback to current code
            }
        }

        return effectiveRunUpdate({
            targetRoot: runnerOptions.targetRoot,
            bundleRoot: bundlePath,
            initAnswersPath: runnerOptions.initAnswersPath,
            dryRun: fallbackDryRun,
            skipVerify: runnerOptions.skipVerify,
            skipManifestValidation: runnerOptions.skipManifestValidation,
            trustContext: {
                policy: runnerOptions.trustPolicy,
                overrideUsed: runnerOptions.trustOverrideUsed,
                overrideSource: runnerOptions.trustOverrideSource,
                sourceType: runnerOptions.sourceType,
                sourceReference: runnerOptions.sourceReference,
                requestedPackageSpec: runnerOptions.requestedPackageSpec || null,
                exactPackageSpec: runnerOptions.exactPackageSpec || null,
                resolvedPackageVersion: runnerOptions.resolvedPackageVersion || null,
                resolvedPackageIntegrity: runnerOptions.resolvedPackageIntegrity || null
            },
            lifecycleLockAlreadyHeld: runnerOptions.lifecycleLockAlreadyHeld === true,
            contractMigrationRunner(options) {
                return effectiveRunContractMigrations(options);
            },
            verifyRunner(options) {
                const result = effectiveRunVerify({
                    targetRoot: options.targetRoot,
                    initAnswersPath: options.initAnswersPath,
                    sourceOfTruth: options.sourceOfTruth
                });
                if (!result.passed) {
                    throw new Error(formatVerifyResult(result));
                }
                return result;
            },
            manifestRunner(options) {
                const manifestPath = path.join(options.targetRoot, resolveBundleName(), 'MANIFEST.md');
                const result = effectiveValidateManifest(manifestPath, options.targetRoot);
                if (!result.passed) {
                    throw new Error(formatManifestResult(result));
                }
                return result;
            }
        }) as UpdateLifecycleResult;
    };
}

export function mergeUpdateLifecycleOutput(
    baseResult: Record<string, unknown>,
    lifecycleResult: UpdateLifecycleResult | null
): Record<string, unknown> {
    if (!lifecycleResult) {
        return baseResult;
    }
    return {
        ...baseResult,
        previousVersion: lifecycleResult.previousVersion,
        updatedVersion: lifecycleResult.updatedVersion,
        workflowConfigMergeStatus: lifecycleResult.workflowConfigMergeStatus,
        projectMemoryMaintenanceSummaryLine: lifecycleResult.projectMemoryMaintenanceSummaryLine,
        projectMemoryRefreshHandoffPrompt: lifecycleResult.projectMemoryRefreshHandoffPrompt,
        rollbackSnapshotPath: lifecycleResult.rollbackSnapshotPath,
        rollbackStatus: lifecycleResult.rollbackStatus,
        updateReportPath: lifecycleResult.updateReportPath,
        requestedPackageSpec: lifecycleResult.requestedPackageSpec ?? baseResult.requestedPackageSpec,
        exactPackageSpec: lifecycleResult.exactPackageSpec ?? baseResult.exactPackageSpec,
        resolvedPackageVersion: lifecycleResult.resolvedPackageVersion ?? baseResult.resolvedPackageVersion,
        resolvedPackageIntegrity: lifecycleResult.resolvedPackageIntegrity ?? baseResult.resolvedPackageIntegrity,
        updateMessages: lifecycleResult.updateMessages,
        releaseNotes: lifecycleResult.releaseNotes,
        updateAnnouncementWarnings: lifecycleResult.updateAnnouncementWarnings
    };
}

export function enrichUpdateOutputWithCurrentBundleAnnouncements(
    baseResult: Record<string, unknown>,
    bundlePath: string
): Record<string, unknown> {
    if (baseResult.updateApplied !== true) {
        return baseResult;
    }

    const previousVersion = String(baseResult.previousVersion || '').trim();
    const updatedVersion = String(baseResult.updatedVersion || baseResult.latestVersion || '').trim();
    if (!previousVersion || !updatedVersion) {
        return baseResult;
    }

    const announcements = collectUpdateAnnouncements(bundlePath, previousVersion, updatedVersion);
    return {
        ...baseResult,
        updateMessages: announcements.updateMessages,
        releaseNotes: announcements.releaseNotes,
        updateAnnouncementWarnings: announcements.warnings
    };
}

export function isFailedValidationResult(result: unknown): result is { passed: false } {
    return result !== null
        && typeof result === 'object'
        && 'passed' in result
        && (result as { passed?: boolean }).passed === false;
}
