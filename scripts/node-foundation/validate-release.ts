import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from './build';

export interface ReleaseVersionParityState {
    repoRoot: string;
    versionFileValue: string | null;
    packageJsonVersion: string | null;
    packageLockVersion: string | null;
    packageLockRootPackageVersion: string | null;
    deployedLiveVersion: string | null;
}

export interface ReleaseVersionParityResult extends ReleaseVersionParityState {
    passed: boolean;
    violations: string[];
}

function readTextFileTrimmed(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8').trim();
}

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getObjectStringValue(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function validateReleaseVersionParity(repoRoot: string): ReleaseVersionParityResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];

    const versionPath = path.join(normalizedRoot, 'VERSION');
    const packageJsonPath = path.join(normalizedRoot, 'package.json');
    const packageLockPath = path.join(normalizedRoot, 'package-lock.json');
    const deployedLiveVersionPath = path.join(normalizedRoot, 'garda-agent-orchestrator', 'live', 'version.json');

    let versionFileValue: string | null = null;
    let packageJsonVersion: string | null = null;
    let packageLockVersion: string | null = null;
    let packageLockRootPackageVersion: string | null = null;
    let deployedLiveVersion: string | null = null;

    if (!fs.existsSync(versionPath)) {
        violations.push(`Missing VERSION file: ${versionPath}`);
    } else {
        versionFileValue = readTextFileTrimmed(versionPath);
        if (!versionFileValue) {
            violations.push(`VERSION file is empty: ${versionPath}`);
        }
    }

    if (!fs.existsSync(packageJsonPath)) {
        violations.push(`Missing package.json: ${packageJsonPath}`);
    } else {
        const pkg = readJsonFile(packageJsonPath);
        if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
            violations.push(`package.json must contain an object: ${packageJsonPath}`);
        } else {
            packageJsonVersion = getObjectStringValue(pkg as Record<string, unknown>, 'version');
            if (!packageJsonVersion) {
                violations.push(`package.json is missing a non-empty version field: ${packageJsonPath}`);
            }
        }
    }

    if (!fs.existsSync(packageLockPath)) {
        violations.push(`Missing package-lock.json: ${packageLockPath}`);
    } else {
        const lock = readJsonFile(packageLockPath);
        if (typeof lock !== 'object' || lock === null || Array.isArray(lock)) {
            violations.push(`package-lock.json must contain an object: ${packageLockPath}`);
        } else {
            const lockRecord = lock as Record<string, unknown>;
            packageLockVersion = getObjectStringValue(lockRecord, 'version');
            if (!packageLockVersion) {
                violations.push(`package-lock.json is missing a non-empty top-level version field: ${packageLockPath}`);
            }

            const packagesValue = lockRecord.packages;
            if (typeof packagesValue !== 'object' || packagesValue === null || Array.isArray(packagesValue)) {
                violations.push(`package-lock.json is missing packages metadata: ${packageLockPath}`);
            } else {
                const rootPackageValue = (packagesValue as Record<string, unknown>)[''];
                if (typeof rootPackageValue !== 'object' || rootPackageValue === null || Array.isArray(rootPackageValue)) {
                    violations.push(`package-lock.json is missing packages[\"\"] metadata: ${packageLockPath}`);
                } else {
                    packageLockRootPackageVersion = getObjectStringValue(rootPackageValue as Record<string, unknown>, 'version');
                    if (!packageLockRootPackageVersion) {
                        violations.push(`package-lock.json packages[\"\"] is missing a non-empty version field: ${packageLockPath}`);
                    }
                }
            }
        }
    }

    if (fs.existsSync(deployedLiveVersionPath)) {
        try {
            const livePayload = readJsonFile(deployedLiveVersionPath);
            if (typeof livePayload !== 'object' || livePayload === null || Array.isArray(livePayload)) {
                violations.push(`garda-agent-orchestrator/live/version.json must contain an object: ${deployedLiveVersionPath}`);
            } else {
                deployedLiveVersion = getObjectStringValue(livePayload as Record<string, unknown>, 'Version');
                if (!deployedLiveVersion) {
                    violations.push(`garda-agent-orchestrator/live/version.json is missing a non-empty Version field: ${deployedLiveVersionPath}`);
                }
            }
        } catch (_error) {
            violations.push(`garda-agent-orchestrator/live/version.json must contain valid JSON: ${deployedLiveVersionPath}`);
        }
    }

    const comparableVersions = [
        ['VERSION', versionFileValue],
        ['package.json', packageJsonVersion],
        ['package-lock.json', packageLockVersion],
        ['package-lock.json packages[""]', packageLockRootPackageVersion],
        ['garda-agent-orchestrator/live/version.json', deployedLiveVersion]
    ] as const;

    const firstPresent = comparableVersions.find(([, value]) => value !== null)?.[1] ?? null;
    if (firstPresent) {
        for (const [label, value] of comparableVersions) {
            if (value !== null && value !== firstPresent) {
                violations.push(`${label} version '${value}' must match '${firstPresent}'.`);
            }
        }
    }

    return {
        passed: violations.length === 0,
        repoRoot: normalizedRoot,
        versionFileValue,
        packageJsonVersion,
        packageLockVersion,
        packageLockRootPackageVersion,
        deployedLiveVersion,
        violations
    };
}

export function formatReleaseVersionParityResult(result: ReleaseVersionParityResult): string {
    const lines: string[] = [];

    if (!result.passed) {
        lines.push('RELEASE_VERSION_PARITY_FAILED');
        lines.push(`RepoRoot: ${result.repoRoot}`);
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
        return lines.join('\n');
    }

    lines.push('RELEASE_VERSION_PARITY_OK');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Version: ${result.versionFileValue || 'n/a'}`);
    return lines.join('\n');
}

export function runReleaseVersionParityValidation(): ReleaseVersionParityResult {
    const result = validateReleaseVersionParity(getRepoRoot());
    console.log(formatReleaseVersionParityResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}

if (require.main === module) {
    runReleaseVersionParityValidation();
}
