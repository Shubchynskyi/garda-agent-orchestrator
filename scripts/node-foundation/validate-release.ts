import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';

import { getRepoRoot } from './build';

const CLEAN_WORKTREE_DIRTY_PATH_LIMIT = 40;
const SECURITY_RELEASE_DOC_ITEMS = Object.freeze([
    'SECURITY.md',
    'docs/threat-model.md',
    'docs/sbom.md'
]);
const PUBLIC_PACKAGE_DOC_ITEMS = Object.freeze([
    'README.md',
    'HOW_TO.md',
    'CHANGELOG.md',
    'docs/architecture.md',
    'docs/cli-reference.md',
    'docs/configuration.md',
    'docs/node-platform-foundation.md',
    'docs/operator-consistency-runbook.md',
    'docs/work-example.md'
]);
const SOURCEFUL_PACKAGE_SURFACE_ITEMS = Object.freeze([
    'bin',
    'dist',
    'src',
    'template',
    'package.json',
    'MANIFEST.md',
    'docs/operator-consistency-runbook.md',
    'VERSION'
]);
export const RELEASE_VALIDATION_COMMANDS = Object.freeze([
    'version-parity',
    'clean-worktree',
    'embedded-bundle-parity',
    'release-readiness'
] as const);

export type ReleaseValidationCommand = typeof RELEASE_VALIDATION_COMMANDS[number];

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
    'docs/architecture.md',
    'docs/cli-reference.md',
    'docs/configuration.md',
    'docs/node-platform-foundation.md',
    'docs/threat-model.md',
    'docs/sbom.md',
    'TRADEMARKS.md',
    'docs/operator-consistency-runbook.md',
    'docs/work-example.md',
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

export interface ReleaseReadinessCheck {
    area: string;
    label: string;
    passed: boolean;
    details: string[];
}

export interface ReleaseReadinessResult {
    repoRoot: string;
    version: string | null;
    passed: boolean;
    violations: string[];
    checks: ReleaseReadinessCheck[];
    blockerTaskIds: string[];
    openBlockerTaskIds: string[];
    releaseNotesInput: string[];
}

export function resolveReleaseValidationCommand(value: string | undefined): ReleaseValidationCommand | null {
    const command = String(value || 'version-parity').trim();
    for (const allowedCommand of RELEASE_VALIDATION_COMMANDS) {
        if (command === allowedCommand) {
            return allowedCommand;
        }
    }
    return null;
}

export const RELEASE_VALIDATION_COMMAND_HANDLERS: Readonly<Record<ReleaseValidationCommand, () => void>> = Object.freeze({
    'version-parity': () => { runReleaseVersionParityValidation(); },
    'clean-worktree': () => { runCleanWorktreePreflight(); },
    'embedded-bundle-parity': () => { runEmbeddedBundleParityValidation(); },
    'release-readiness': () => { runReleaseReadinessValidation(); }
});

export function runReleaseValidationCli(rawCommand: string | undefined): void {
    const command = resolveReleaseValidationCommand(rawCommand);
    if (command === null) {
        console.error(`Unknown validate-release command: ${String(rawCommand || '').trim()}`);
        console.error(`Usage: validate-release.js [${RELEASE_VALIDATION_COMMANDS.join('|')}]`);
        process.exit(1);
    }

    RELEASE_VALIDATION_COMMAND_HANDLERS[command]();
}

if (require.main === module) {
    runReleaseValidationCli(process.argv[2]);
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

function readTextFileIfExists(filePath: string): string | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    return fs.readFileSync(filePath, 'utf8');
}

function readPackageJsonObject(repoRoot: string, violations: string[]): Record<string, unknown> | null {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        violations.push(`Missing package.json: ${packageJsonPath}`);
        return null;
    }

    const payload = readJsonFile(packageJsonPath);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        violations.push(`package.json must contain an object: ${packageJsonPath}`);
        return null;
    }

    return payload as Record<string, unknown>;
}

function getStringRecord(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }

    const output: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') {
            output[key] = entry;
        }
    }
    return output;
}

function getStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
}

function countOccurrences(value: string, needle: string): number {
    if (!needle) {
        return 0;
    }
    return value.split(needle).length - 1;
}

function pushCheck(
    checks: ReleaseReadinessCheck[],
    violations: string[],
    area: string,
    label: string,
    passed: boolean,
    details: string[]
): void {
    checks.push({ area, label, passed, details });
    if (!passed) {
        violations.push(`${area}: ${label}`);
    }
}

function extractRelease110TaskIds(taskMarkdown: string): string[] {
    const taskIds: string[] = [];
    let inRelease110Section = false;

    for (const line of taskMarkdown.split(/\r?\n/u)) {
        if (/^###\s+Релиз 1\.1\.0\b/u.test(line)) {
            inRelease110Section = true;
            continue;
        }
        if (inRelease110Section && /^###\s+Релиз\s+/u.test(line)) {
            break;
        }
        if (!inRelease110Section) {
            continue;
        }

        const match = line.match(/^-\s+`(T-\d+)`/u);
        if (!match) {
            continue;
        }
        const taskId = match[1];
        if (taskId === 'T-244') {
            break;
        }
        taskIds.push(taskId);
    }

    return taskIds;
}

function parseTaskStatuses(taskMarkdown: string): Map<string, string> {
    const statuses = new Map<string, string>();
    for (const line of taskMarkdown.split(/\r?\n/u)) {
        const match = line.match(/^\|\s*(T-\d+)\s*\|\s*([^|]+?)\s*\|/u);
        if (match) {
            statuses.set(match[1], match[2].trim());
        }
    }
    return statuses;
}

function validateReleaseBlockers(repoRoot: string): {
    blockerTaskIds: string[];
    openBlockerTaskIds: string[];
    details: string[];
} {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const taskMarkdown = readTextFileIfExists(taskPath);
    if (taskMarkdown === null) {
        return {
            blockerTaskIds: [],
            openBlockerTaskIds: [],
            details: [`Missing TASK.md: ${taskPath}`]
        };
    }

    const blockerTaskIds = extractRelease110TaskIds(taskMarkdown);
    const statuses = parseTaskStatuses(taskMarkdown);
    const openBlockerTaskIds = blockerTaskIds.filter((taskId) => !(statuses.get(taskId) || '').includes('DONE'));
    const details = [
        `Release 1.1.0 blockers before T-244: ${blockerTaskIds.length}`,
        `Open blockers: ${openBlockerTaskIds.length === 0 ? 'none' : openBlockerTaskIds.join(', ')}`
    ];

    if (blockerTaskIds.length === 0) {
        details.push('No blocker task ids were found in the Release 1.1.0 section.');
    }

    return { blockerTaskIds, openBlockerTaskIds, details };
}

function fileExists(repoRoot: string, relativePath: string): boolean {
    const resolvedPath = path.join(repoRoot, ...relativePath.split('/'));
    return fs.existsSync(resolvedPath);
}

function manifestListsEvery(manifestText: string, relativePaths: readonly string[]): boolean {
    return relativePaths.every((relativePath) => manifestText.includes(relativePath));
}

function getWorkflowJobBlock(workflowText: string, jobId: string): string | null {
    const lines = workflowText.split(/\r?\n/u);
    const jobPattern = new RegExp(`^(\\s*)${jobId}:\\s*$`, 'u');
    const jobStart = lines.findIndex((line) => jobPattern.test(line));
    if (jobStart === -1) {
        return null;
    }
    const jobIndent = jobPattern.exec(lines[jobStart])![1].length;
    const nextJobPattern = new RegExp(`^\\s{${jobIndent}}[A-Za-z0-9_-]+:\\s*$`, 'u');
    const nextJob = lines.findIndex((line, index) => index > jobStart && nextJobPattern.test(line));
    return lines.slice(jobStart, nextJob === -1 ? undefined : nextJob).join('\n');
}

function extractYamlListAfterKey(block: string | null, key: string): string[] {
    if (block === null) {
        return [];
    }
    const lines = block.split(/\r?\n/u);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    if (keyIndex === -1) {
        return [];
    }
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    const values: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
        const indent = line.match(/^\s*/u)![0].length;
        if (line.trim() && indent <= keyIndent) {
            break;
        }
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (item) {
            values.push(item[1].replace(/^['"]|['"]$/gu, ''));
        }
    }
    return values;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workflowJobHasRunStep(block: string | null, command: string): boolean {
    return block !== null && block.includes(`run: ${command}`);
}

function validateCiRuntimeMatrixContract(ciWorkflow: string): { passed: boolean; details: string[] } {
    const releaseJob = getWorkflowJobBlock(ciWorkflow, 'validate-release');
    const smokeJob = getWorkflowJobBlock(ciWorkflow, 'smoke');
    const supportedNodeLines = ['22.13.0', '24'];
    const releaseOsLines = ['ubuntu-latest', 'windows-latest'];
    const smokeOsLines = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
    const releaseNodeVersions = extractYamlListAfterKey(releaseJob, 'node-version');
    const smokeNodeVersions = extractYamlListAfterKey(smokeJob, 'node-version');
    const releaseOsVersions = extractYamlListAfterKey(releaseJob, 'os');
    const smokeOsVersions = extractYamlListAfterKey(smokeJob, 'os');
    const releaseMatrixOk = stringArraysEqual(releaseNodeVersions, supportedNodeLines)
        && stringArraysEqual(releaseOsVersions, releaseOsLines)
        && workflowJobHasRunStep(releaseJob, 'npm run validate:release');
    const smokeMatrixOk = stringArraysEqual(smokeNodeVersions, supportedNodeLines)
        && stringArraysEqual(smokeOsVersions, smokeOsLines)
        && workflowJobHasRunStep(smokeJob, '$CLI setup')
        && workflowJobHasRunStep(smokeJob, '$CLI update git')
        && workflowJobHasRunStep(smokeJob, '$CLI doctor')
        && workflowJobHasRunStep(smokeJob, '$CLI uninstall');
    return {
        passed: releaseMatrixOk && smokeMatrixOk,
        details: [
            `validate-release node-version=${releaseNodeVersions.join(', ') || 'missing'}`,
            `validate-release os=${releaseOsVersions.join(', ') || 'missing'}`,
            `smoke node-version=${smokeNodeVersions.join(', ') || 'missing'}`,
            `smoke os=${smokeOsVersions.join(', ') || 'missing'}`
        ]
    };
}

function validateReleaseReadinessContracts(repoRoot: string): ReleaseReadinessResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];
    const checks: ReleaseReadinessCheck[] = [];
    const packageJson = readPackageJsonObject(normalizedRoot, violations);
    const scripts = getStringRecord(packageJson?.scripts);
    const packageFiles = getStringArray(packageJson?.files);
    const version = typeof packageJson?.version === 'string' ? packageJson.version : null;

    const validateRelease = scripts['validate:release'] || '';
    const validateReadiness = scripts['validate:release-readiness'] || '';
    const releasePreflight = scripts['release:preflight'] || '';
    const quality = scripts.quality || '';
    const prepack = scripts.prepack || '';
    const manifestText = readTextFileIfExists(path.join(normalizedRoot, 'MANIFEST.md')) || '';

    pushCheck(
        checks,
        violations,
        'package',
        'validate:release composes clean worktree, version parity, build, embedded parity, quality, pack smoke, and final clean worktree',
        Boolean(validateRelease) &&
            validateRelease.includes('npm run validate:version-parity') &&
            validateRelease.includes('npm run build') &&
            validateRelease.includes('npm run validate:embedded-bundle-parity') &&
            validateRelease.includes('npm run quality') &&
            validateRelease.includes('node --test .node-build/tests/node/packaging/pack-smoke.test.js') &&
            countOccurrences(validateRelease, 'npm run validate:clean-worktree') >= 2,
        [validateRelease || 'missing validate:release']
    );

    pushCheck(
        checks,
        violations,
        'release-gate',
        'release:preflight runs release readiness before the expensive release validation path',
        validateReadiness === 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness' &&
            releasePreflight === 'npm run validate:release-readiness && npm run validate:release',
        [
            `validate:release-readiness=${validateReadiness || 'missing'}`,
            `release:preflight=${releasePreflight || 'missing'}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'security',
        'quality keeps production audit in the release chain and security document surface is package/manifest aligned',
        quality.includes('npm run audit:prod') &&
            scripts['audit:prod'] === 'npm audit --omit=dev' &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => packageFiles.includes(entry)) &&
            manifestListsEvery(manifestText, SECURITY_RELEASE_DOC_ITEMS),
        [
            quality || 'missing quality',
            `audit:prod=${scripts['audit:prod'] || 'missing'}`,
            `security_docs=${SECURITY_RELEASE_DOC_ITEMS.join(', ')}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'packaging',
        'prepack and package files preserve clean-package, sourceful runtime, and linked public-doc contracts',
        prepack.includes('npm run validate:clean-worktree') &&
            prepack.includes('npm run build:publish-runtime') &&
            prepack.includes('node scripts/package-legacy-entrypoint-compat.cjs create') &&
            SOURCEFUL_PACKAGE_SURFACE_ITEMS
                .concat(SECURITY_RELEASE_DOC_ITEMS)
                .concat(PUBLIC_PACKAGE_DOC_ITEMS)
                .every((entry) => packageFiles.includes(entry)) &&
            PUBLIC_PACKAGE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            manifestListsEvery(manifestText, PUBLIC_PACKAGE_DOC_ITEMS) &&
            !packageFiles.includes('.node-build'),
        [prepack || 'missing prepack', `files=${packageFiles.join(', ') || 'missing'}`]
    );

    const ciWorkflow = readTextFileIfExists(path.join(normalizedRoot, '.github', 'workflows', 'ci.yml')) || '';
    const ciRuntimeMatrix = validateCiRuntimeMatrixContract(ciWorkflow);
    pushCheck(
        checks,
        violations,
        'ci',
        'CI keeps release validation on Linux and Windows, Node 22.13+ and Node 24 matrices, and lifecycle update smoke on all supported OS families',
        ciRuntimeMatrix.passed,
        ciRuntimeMatrix.details
    );

    const cliReference = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'cli-reference.md')) || '';
    const runMethods = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'run-methods.md')) || '';
    const platformDocs = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'node-platform-foundation.md')) || '';
    pushCheck(
        checks,
        violations,
        'runtime-state',
        'operator docs keep doctor, manifest validation, task-event timelines, and derived-index recovery visible',
        cliReference.includes('garda doctor') &&
            cliReference.includes('garda gate validate-manifest') &&
            cliReference.includes('runtime/task-events/<task-id>.jsonl') &&
            runMethods.includes('gate validate-manifest') &&
            platformDocs.includes('cross-platform lifecycle smoke'),
        ['docs/cli-reference.md, docs/run-methods.md, docs/node-platform-foundation.md']
    );

    const blockers = validateReleaseBlockers(normalizedRoot);
    pushCheck(
        checks,
        violations,
        'release-blockers',
        'all required Release 1.1.0 blocker tasks before T-244 are closed',
        blockers.blockerTaskIds.length > 0 && blockers.openBlockerTaskIds.length === 0,
        blockers.details
    );

    const releaseNotesInput = [
        `Version: ${version || 'unknown'}`,
        'Validation command: npm run release:preflight',
        'Package proof: validate:release covers clean worktree, version parity, build, embedded bundle parity, quality, pack smoke, and final clean worktree.',
        'Readiness alignment: validate:release-readiness checks package, CI runtime matrix, runtime-state docs, security-document surface, and Release 1.1.0 blocker wiring before the full proof path.',
        'Update/runtime alignment: CI workflow is configured for setup, update git, doctor, and uninstall smoke across Linux, Windows, and macOS.',
        'Security/audit alignment: quality includes production npm audit and security/SBOM/threat-model docs are present in source, package files, and MANIFEST.'
    ];

    return {
        repoRoot: normalizedRoot,
        version,
        passed: violations.length === 0,
        violations,
        checks,
        blockerTaskIds: blockers.blockerTaskIds,
        openBlockerTaskIds: blockers.openBlockerTaskIds,
        releaseNotesInput
    };
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

export function validateReleaseReadiness(repoRoot: string): ReleaseReadinessResult {
    return validateReleaseReadinessContracts(repoRoot);
}

export function formatReleaseReadinessResult(result: ReleaseReadinessResult): string {
    const lines: string[] = [];

    lines.push(result.passed ? 'RELEASE_READINESS_OK' : 'RELEASE_READINESS_FAILED');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Version: ${result.version || 'unknown'}`);
    lines.push(`BlockerTasks: ${result.blockerTaskIds.length}`);
    lines.push(`OpenBlockers: ${result.openBlockerTaskIds.length === 0 ? 'none' : result.openBlockerTaskIds.join(', ')}`);
    lines.push('Checklist:');
    for (const check of result.checks) {
        lines.push(`  [${check.passed ? 'x' : ' '}] ${check.area}: ${check.label}`);
        if (!check.passed) {
            for (const detail of check.details) {
                lines.push(`      - ${detail}`);
            }
        }
    }

    if (!result.passed) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    lines.push('ReleaseNotesInput:');
    for (const entry of result.releaseNotesInput) {
        lines.push(`- ${entry}`);
    }

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

export function runReleaseReadinessValidation(): ReleaseReadinessResult {
    const result = validateReleaseReadiness(getRepoRoot());
    console.log(formatReleaseReadinessResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}
