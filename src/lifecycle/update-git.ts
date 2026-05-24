import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import {
    DEFAULT_GIT_CLONE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    DEFAULT_NPM_TIMEOUT_MS,
    DEFAULT_COMPILE_TIMEOUT_MS,
    spawnStreamed,
    spawnSyncWithTimeout
} from '../core/subprocess';
import { removePathRecursive } from './common';
import { type CheckUpdateRunnerOptions, runCheckUpdate } from './check-update';
import { validateGitSourceTrust } from './update-trust';
import {
    classifyGitDiagnostic,
    classifyNpmDiagnostic,
    createLifecycleDiagnosticError
} from './update-diagnostics';
import { registerTempRoot } from '../cli/signal-handler';
import { pathExists } from '../core/filesystem';
import { assertUpdateApplyAllowedInSwitchMode } from './update-off-mode';

export const DEFAULT_GIT_UPDATE_REPO_URL = 'https://github.com/Shubchynskyi/garda-agent-orchestrator.git';

interface GitCloneHandle {
    clonePath: string;
    cleanup: () => void;
}

interface RunUpdateFromGitOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    repoUrl?: string;
    branch?: string | null;
    checkOnly?: boolean;
    noPrompt?: boolean;
    dryRun?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    trustOverride?: boolean;
    updateRunner?: ((options: CheckUpdateRunnerOptions) => unknown) | null;
}

interface NpmInvocation {
    command: string;
    prefixArgs: string[];
}

export function buildGitCloneArgs(repoUrl: string, branch: string | null | undefined, destinationPath: string): string[] {
    const args = ['clone', '--depth', '1'];
    if (branch) {
        args.push('--branch', String(branch).trim(), '--single-branch');
    }
    args.push(String(repoUrl).trim(), destinationPath);
    return args;
}

let resolvedNpmInvocation: NpmInvocation | null = null;

function resolveNpmInvocation(): NpmInvocation {
    if (resolvedNpmInvocation) {
        return resolvedNpmInvocation;
    }

    const npmExecPath = String(process.env.npm_execpath || '').trim();
    if (npmExecPath && pathExists(npmExecPath)) {
        resolvedNpmInvocation = {
            command: process.execPath,
            prefixArgs: [npmExecPath]
        };
        return resolvedNpmInvocation;
    }

    const bundledCandidates = [
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];

    for (const candidate of bundledCandidates) {
        const resolvedCandidate = path.resolve(candidate);
        if (pathExists(resolvedCandidate)) {
            resolvedNpmInvocation = {
                command: process.execPath,
                prefixArgs: [resolvedCandidate]
            };
            return resolvedNpmInvocation;
        }
    }

    resolvedNpmInvocation = {
        command: 'npm',
        prefixArgs: []
    };
    return resolvedNpmInvocation;
}

function hasCompiledRuntime(sourceRoot: string): boolean {
    return pathExists(path.join(sourceRoot, 'dist', 'src', 'index.js'));
}

async function runNpmInSource(
    sourceRoot: string,
    args: string[],
    timeoutMs: number
) {
    const invocation = resolveNpmInvocation();
    return spawnStreamed(invocation.command, [...invocation.prefixArgs, ...args], {
        cwd: sourceRoot,
        timeoutMs
    });
}

async function prepareGitUpdateSource(sourceRoot: string, diagnosticSource: string): Promise<void> {
    if (hasCompiledRuntime(sourceRoot)) {
        return;
    }

    const packageJsonPath = path.join(sourceRoot, 'package.json');
    if (!pathExists(packageJsonPath)) {
        throw createLifecycleDiagnosticError({
            message: `Git update source '${diagnosticSource}' is missing package.json and cannot be materialized into a runnable bundle.`,
            tool: 'npm',
            code: 'UPDATE_SOURCE_BUILD_FAILED',
            sourceReference: diagnosticSource,
            detailText: packageJsonPath
        });
    }

    const installArgs = pathExists(path.join(sourceRoot, 'package-lock.json'))
        ? ['ci', '--ignore-scripts', '--no-fund', '--no-audit', '--prefer-offline']
        : ['install', '--ignore-scripts', '--no-fund', '--no-audit', '--prefer-offline'];

    const installResult = await runNpmInSource(sourceRoot, installArgs, DEFAULT_NPM_TIMEOUT_MS);
    const installText = `${String(installResult.stderr || '')}\n${String(installResult.stdout || '')}`;
    if (installResult.timedOut) {
        throw createLifecycleDiagnosticError({
            message: `Timed out preparing npm dependencies for git update source '${diagnosticSource}'.`,
            tool: 'npm',
            code: 'UPDATE_SOURCE_DEP_INSTALL_TIMEOUT',
            sourceReference: diagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }
    if (installResult.exitCode !== 0) {
        const classified = classifyNpmDiagnostic(installText);
        throw createLifecycleDiagnosticError({
            message: `Failed to prepare npm dependencies for git update source '${diagnosticSource}'.`,
            tool: 'npm',
            code: classified === 'NPM_UNKNOWN' ? 'UPDATE_SOURCE_DEP_INSTALL_FAILED' : classified,
            sourceReference: diagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    const buildResult = await runNpmInSource(sourceRoot, ['run', 'build'], DEFAULT_COMPILE_TIMEOUT_MS);

    if (buildResult.timedOut) {
        throw createLifecycleDiagnosticError({
            message: `Timed out building git update source '${diagnosticSource}'.`,
            tool: 'npm',
            code: 'UPDATE_SOURCE_BUILD_TIMEOUT',
            sourceReference: diagnosticSource,
            stderr: buildResult.stderr,
            stdout: buildResult.stdout
        });
    }
    if (buildResult.exitCode !== 0) {
        throw createLifecycleDiagnosticError({
            message: `Failed to build git update source '${diagnosticSource}' into a runnable bundle.`,
            tool: 'npm',
            code: 'UPDATE_SOURCE_BUILD_FAILED',
            sourceReference: diagnosticSource,
            stderr: buildResult.stderr,
            stdout: buildResult.stdout
        });
    }

    if (!hasCompiledRuntime(sourceRoot)) {
        throw createLifecycleDiagnosticError({
            message: `Git update source '${diagnosticSource}' finished build without producing dist/src/index.js.`,
            tool: 'npm',
            code: 'UPDATE_SOURCE_BUILD_FAILED',
            sourceReference: diagnosticSource,
            detailText: path.join(sourceRoot, 'dist', 'src', 'index.js')
        });
    }
}

function ensureGitAvailable() {
    const result = spawnSyncWithTimeout('git', ['--version'], {
        stdio: 'pipe',
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) {
        const detailText = result.error ? (result.error.message || String(result.error)) : '';
        throw createLifecycleDiagnosticError({
            message: 'git is required for update git workflow.',
            tool: 'git',
            code: 'GIT_NOT_AVAILABLE',
            sourceReference: 'git',
            stderr: result.stderr,
            stdout: result.stdout,
            detailText
        });
    }
}

export async function cloneGitUpdateSource(repoUrl: string, branch: string | null): Promise<GitCloneHandle> {
    ensureGitAvailable();

    const tempClonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-update-git-'));
    const disposeSignalCleanup = registerTempRoot(tempClonePath);
    const diagnosticSource = branch ? `${repoUrl}#${branch}` : repoUrl;
    const cloneResult = await spawnStreamed('git', buildGitCloneArgs(repoUrl, branch, tempClonePath), {
        timeoutMs: DEFAULT_GIT_CLONE_TIMEOUT_MS,
        onStderr(chunk) { process.stderr.write(chunk); }
    });

    if (cloneResult.timedOut) {
        disposeSignalCleanup();
        removePathRecursive(tempClonePath);
        throw createLifecycleDiagnosticError({
            message: `git clone timed out after ${DEFAULT_GIT_CLONE_TIMEOUT_MS} ms for '${repoUrl}'.`,
            tool: 'git',
            code: 'GIT_TIMEOUT',
            sourceReference: diagnosticSource,
            stderr: cloneResult.stderr,
            stdout: cloneResult.stdout
        });
    }

    if (cloneResult.exitCode !== 0) {
        disposeSignalCleanup();
        removePathRecursive(tempClonePath);
        const diagnosticText = `${String(cloneResult.stderr || '')}\n${String(cloneResult.stdout || '')}`;
        throw createLifecycleDiagnosticError({
            message: `Failed to clone git update source '${repoUrl}'.`,
            tool: 'git',
            code: classifyGitDiagnostic(diagnosticText),
            sourceReference: diagnosticSource,
            stderr: cloneResult.stderr,
            stdout: cloneResult.stdout
        });
    }

    return {
        clonePath: tempClonePath,
        cleanup() {
            disposeSignalCleanup();
            removePathRecursive(tempClonePath);
        }
    };
}

export async function runUpdateFromGit(options: RunUpdateFromGitOptions) {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        repoUrl = DEFAULT_GIT_UPDATE_REPO_URL,
        branch = null,
        checkOnly = false,
        noPrompt = true,
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        trustOverride = false,
        updateRunner = null
    } = options;

    const normalizedRepoUrl = String(repoUrl || DEFAULT_GIT_UPDATE_REPO_URL).trim();
    const normalizedBranch = branch ? String(branch).trim() : null;

    const trustResult = validateGitSourceTrust(normalizedRepoUrl, { trustOverride });
    assertUpdateApplyAllowedInSwitchMode({
        targetRoot,
        bundleRoot,
        applyRequested: !checkOnly,
        dryRun,
        commandName: 'update git'
    });

    const gitSource = await cloneGitUpdateSource(normalizedRepoUrl, normalizedBranch);

    try {
        if (!checkOnly && !dryRun) {
            await prepareGitUpdateSource(
                gitSource.clonePath,
                normalizedBranch ? `${normalizedRepoUrl}#${normalizedBranch}` : normalizedRepoUrl
            );
        }

        const result = await runCheckUpdate({
            targetRoot,
            bundleRoot,
            initAnswersPath,
            sourcePath: gitSource.clonePath,
            diagnosticSourceReference: normalizedBranch ? `${normalizedRepoUrl}#${normalizedBranch}` : normalizedRepoUrl,
            diagnosticTool: 'git',
            apply: !checkOnly,
            noPrompt,
            dryRun,
            skipVerify,
            skipManifestValidation,
            trustOverride: false,
            prevalidatedPathTrustResult: trustResult,
            updateRunner
        });

        return {
            ...result,
            sourceType: 'git',
            sourceReference: normalizedRepoUrl,
            sourcePath: null,
            repoUrl: normalizedRepoUrl,
            branch: normalizedBranch,
            trustPolicy: trustResult.policy
        };
    } finally {
        gitSource.cleanup();
    }
}
