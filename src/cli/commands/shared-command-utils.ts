import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    LIFECYCLE_COMMANDS,
    resolveBundleName
} from '../../core/constants';
import { formatManifestResult, validateManifest } from '../../validators/validate-manifest';
import { formatVerifyResult, runVerify } from '../../validators/verify';
import { runContractMigrations } from '../../lifecycle/contract-migrations';
import { runUpdate } from '../../lifecycle/update';
import { type CheckUpdateRunnerOptions } from '../../lifecycle/check-update';
import { getBundlePath } from './cli-helpers';

export type ParsedOptionValue = string | boolean | string[] | undefined;
export type ParsedOptionsRecord = Record<string, ParsedOptionValue>;

export interface UpdateLifecycleResult extends Record<string, unknown> {
    previousVersion?: unknown;
    updatedVersion?: unknown;
    rollbackSnapshotPath?: unknown;
    rollbackStatus?: unknown;
    updateReportPath?: unknown;
}

export class ValidationFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationFailureError';
        Object.setPrototypeOf(this, ValidationFailureError.prototype);
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

export function formatKeyValueOutput(obj: Record<string, unknown> | null | undefined, keys: string[]): void {
    if (!obj) {
        return;
    }
    for (const key of keys) {
        if (obj[key] === undefined) {
            continue;
        }
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        const value = typeof obj[key] === 'boolean'
            ? (obj[key] ? 'True' : 'False')
            : String(obj[key]);
        console.log(`${label}: ${value}`);
    }
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
                [targetUpdateModulePath, targetMigrationModulePath, targetVerifyModulePath, targetManifestModulePath].forEach((modulePath) => {
                    try {
                        const resolved = require.resolve(modulePath);
                        if (require.cache[resolved]) {
                            delete require.cache[resolved];
                        }
                    } catch {
                        // ignore cache miss
                    }
                });

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
                sourceReference: runnerOptions.sourceReference
            },
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
        rollbackSnapshotPath: lifecycleResult.rollbackSnapshotPath,
        rollbackStatus: lifecycleResult.rollbackStatus,
        updateReportPath: lifecycleResult.updateReportPath
    };
}

export function isFailedValidationResult(result: unknown): result is { passed: false } {
    return result !== null
        && typeof result === 'object'
        && 'passed' in result
        && (result as { passed?: boolean }).passed === false;
}
