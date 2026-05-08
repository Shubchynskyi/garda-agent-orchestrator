import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';

import { getRepoRoot } from './build';

const CLEAN_WORKTREE_DIRTY_PATH_LIMIT = 40;

export const EMBEDDED_BUNDLE_PARITY_ITEMS = Object.freeze([
    '.gitattributes',
    'bin',
    'dist',
    'package.json',
    'src',
    'template',
    'README.md',
    'HOW_TO.md',
    'MANIFEST.md',
    'AGENT_INIT_PROMPT.md',
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'TRADEMARKS.md',
    'docs/operator-consistency-runbook.md',
    'VERSION'
]);

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

export interface CleanWorktreePreflightState {
    repoRoot: string;
    headSha: string | null;
    branchName: string | null;
    detachedHead: boolean;
    dirtyPaths: string[];
}

export interface CleanWorktreePreflightResult extends CleanWorktreePreflightState {
    passed: boolean;
    violations: string[];
    remediation: string;
}

export interface EmbeddedBundleParityItemResult {
    item: string;
    rootExists: boolean;
    bundleExists: boolean;
    rootHash: string | null;
    bundleHash: string | null;
}

export interface EmbeddedBundleParityResult {
    repoRoot: string;
    bundleRoot: string;
    bundlePresent: boolean;
    bundleIgnoredByGit: boolean;
    checkedItems: string[];
    passed: boolean;
    violations: string[];
    items: EmbeddedBundleParityItemResult[];
}

function readTextFileTrimmed(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8').trim();
}

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRelativePath(value: string): string {
    return value.split(path.sep).join('/');
}

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(rootPath: string): string[] {
    const stat = fs.lstatSync(rootPath);
    if (!stat.isDirectory()) {
        return [rootPath];
    }

    const files: string[] = [];
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(entryPath));
            continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

function hashSurfaceItem(itemPath: string): string {
    const hash = crypto.createHash('sha256');
    const stat = fs.lstatSync(itemPath);
    if (!stat.isDirectory()) {
        hash.update('.');
        hash.update('\0');
        hash.update(stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(itemPath)}` : hashFile(itemPath));
        hash.update('\n');
        return hash.digest('hex');
    }

    for (const filePath of listFiles(itemPath)) {
        const fileStat = fs.lstatSync(filePath);
        const relativePath = normalizeRelativePath(path.relative(itemPath, filePath));
        hash.update(relativePath);
        hash.update('\0');
        hash.update(fileStat.isSymbolicLink() ? `symlink:${fs.readlinkSync(filePath)}` : hashFile(filePath));
        hash.update('\n');
    }
    return hash.digest('hex');
}

function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
}

function isGitIgnored(repoRoot: string, relativePath: string): boolean {
    const result = runGit(repoRoot, ['check-ignore', '-q', '--', relativePath]);
    return result.status === 0;
}

function formatGitFailure(label: string, result: childProcess.SpawnSyncReturns<string>): string {
    const details: string[] = [label];
    if (result.error) {
        details.push(result.error.message);
    }
    if (result.status !== null) {
        details.push(`exit ${result.status}`);
    }
    if (result.signal) {
        details.push(`signal ${result.signal}`);
    }
    const stderr = String(result.stderr || '').trim();
    if (stderr) {
        details.push(stderr);
    }
    const stdout = String(result.stdout || '').trim();
    if (stdout) {
        details.push(stdout);
    }
    return details.join(': ');
}

function parsePorcelainDirtyPaths(statusOutput: string): string[] {
    return statusOutput
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
            if (line.length <= 3) {
                return line.trim();
            }
            return line.slice(3).trim();
        })
        .filter(Boolean);
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

export function validateCleanWorktreePreflight(repoRoot: string): CleanWorktreePreflightResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];
    const remediation = 'Commit intentional changes or explicitly roll back/remove accidental tracked and untracked files before creating a release archive.';

    let headSha: string | null = null;
    let branchName: string | null = null;
    let detachedHead = false;
    let dirtyPaths: string[] = [];

    const headResult = runGit(normalizedRoot, ['rev-parse', '--verify', 'HEAD']);
    if (headResult.status !== 0) {
        violations.push(formatGitFailure('Cannot resolve git HEAD for release preflight', headResult));
    } else {
        headSha = String(headResult.stdout || '').trim() || null;
    }

    const branchResult = runGit(normalizedRoot, ['branch', '--show-current']);
    if (branchResult.status !== 0) {
        violations.push(formatGitFailure('Cannot resolve git branch for release preflight', branchResult));
    } else {
        branchName = String(branchResult.stdout || '').trim() || null;
        detachedHead = branchName === null;
    }

    const statusResult = runGit(normalizedRoot, [
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all'
    ]);
    if (statusResult.status !== 0) {
        violations.push(formatGitFailure('Cannot inspect git worktree status for release preflight', statusResult));
    } else {
        dirtyPaths = parsePorcelainDirtyPaths(String(statusResult.stdout || ''));
        if (dirtyPaths.length > 0) {
            violations.push(`Release worktree must be clean; found ${dirtyPaths.length} dirty path(s).`);
        }
    }

    return {
        passed: violations.length === 0,
        repoRoot: normalizedRoot,
        headSha,
        branchName,
        detachedHead,
        dirtyPaths,
        violations,
        remediation
    };
}

export function validateEmbeddedBundleParity(
    repoRoot: string,
    items: readonly string[] = EMBEDDED_BUNDLE_PARITY_ITEMS
): EmbeddedBundleParityResult {
    const normalizedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(normalizedRoot, 'garda-agent-orchestrator');
    const bundlePresent = fs.existsSync(bundleRoot);
    const bundleIgnoredByGit = bundlePresent && isGitIgnored(normalizedRoot, 'garda-agent-orchestrator');
    const violations: string[] = [];
    const itemResults: EmbeddedBundleParityItemResult[] = [];
    const checkedItems = [...items];

    if (!bundlePresent || bundleIgnoredByGit) {
        return {
            repoRoot: normalizedRoot,
            bundleRoot,
            bundlePresent,
            bundleIgnoredByGit,
            checkedItems,
            passed: true,
            violations,
            items: itemResults
        };
    }

    for (const item of checkedItems) {
        const rootItemPath = path.join(normalizedRoot, item);
        const bundleItemPath = path.join(bundleRoot, item);
        const rootExists = fs.existsSync(rootItemPath);
        const bundleExists = fs.existsSync(bundleItemPath);
        const rootHash = rootExists ? hashSurfaceItem(rootItemPath) : null;
        const bundleHash = bundleExists ? hashSurfaceItem(bundleItemPath) : null;

        itemResults.push({
            item,
            rootExists,
            bundleExists,
            rootHash,
            bundleHash
        });

        if (!rootExists || !bundleExists) {
            violations.push(`${item}: missing root=${rootExists} bundle=${bundleExists}`);
            continue;
        }
        if (rootHash !== bundleHash) {
            violations.push(`${item}: hash mismatch`);
        }
    }

    return {
        repoRoot: normalizedRoot,
        bundleRoot,
        bundlePresent,
        bundleIgnoredByGit,
        checkedItems,
        passed: violations.length === 0,
        violations,
        items: itemResults
    };
}

export function formatCleanWorktreePreflightResult(result: CleanWorktreePreflightResult): string {
    const lines: string[] = [];

    lines.push(result.passed ? 'RELEASE_CLEAN_WORKTREE_OK' : 'RELEASE_CLEAN_WORKTREE_FAILED');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Head: ${result.headSha || 'unresolved'}`);
    lines.push(`Branch: ${result.branchName || 'DETACHED'}`);
    lines.push(`DetachedHead: ${result.detachedHead ? 'yes (allowed)' : 'no'}`);
    lines.push(`DirtyPaths: ${result.dirtyPaths.length}`);

    if (!result.passed) {
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
        const visibleDirtyPaths = result.dirtyPaths.slice(0, CLEAN_WORKTREE_DIRTY_PATH_LIMIT);
        for (const dirtyPath of visibleDirtyPaths) {
            lines.push(`  - ${dirtyPath}`);
        }
        if (result.dirtyPaths.length > visibleDirtyPaths.length) {
            lines.push(`  - ... ${result.dirtyPaths.length - visibleDirtyPaths.length} more`);
        }
        lines.push(`Remediation: ${result.remediation}`);
    }

    return lines.join('\n');
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

export function formatEmbeddedBundleParityResult(result: EmbeddedBundleParityResult): string {
    const lines: string[] = [];

    if (!result.passed) {
        lines.push('RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED');
        lines.push(`RepoRoot: ${result.repoRoot}`);
        lines.push(`BundleRoot: ${result.bundleRoot}`);
        lines.push(`CheckedItems: ${result.checkedItems.length}`);
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
        lines.push('Remediation: refresh the generated embedded bundle from the root source before release.');
        return lines.join('\n');
    }

    lines.push('RELEASE_EMBEDDED_BUNDLE_PARITY_OK');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`BundleRoot: ${result.bundleRoot}`);
    if (result.bundleIgnoredByGit) {
        lines.push('BundlePresent: yes (gitignored generated artifact omitted from release surface)');
    } else {
        lines.push(`BundlePresent: ${result.bundlePresent ? 'yes' : 'no (generated artifact omitted)'}`);
    }
    lines.push(`CheckedItems: ${result.bundlePresent && !result.bundleIgnoredByGit ? result.checkedItems.length : 0}`);
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

export function runCleanWorktreePreflight(): CleanWorktreePreflightResult {
    const result = validateCleanWorktreePreflight(getRepoRoot());
    console.log(formatCleanWorktreePreflightResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}

export function runEmbeddedBundleParityValidation(): EmbeddedBundleParityResult {
    const result = validateEmbeddedBundleParity(getRepoRoot());
    console.log(formatEmbeddedBundleParityResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}

if (require.main === module) {
    const command = String(process.argv[2] || 'version-parity').trim();
    if (command === 'version-parity') {
        runReleaseVersionParityValidation();
    } else if (command === 'clean-worktree') {
        runCleanWorktreePreflight();
    } else if (command === 'embedded-bundle-parity') {
        runEmbeddedBundleParityValidation();
    } else {
        console.error(`Unknown validate-release command: ${command}`);
        console.error('Usage: validate-release.js [version-parity|clean-worktree|embedded-bundle-parity]');
        process.exit(1);
    }
}
