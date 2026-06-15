import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_GIT_CLONE_TIMEOUT_MS, spawnStreamed } from '../../core/subprocess';
import { registerTempRoot } from '../signal-handler';
import { DEFAULT_REPO_URL } from './cli-constants';
import { readBundleVersion } from './cli-bundle-helpers';

const PROCESS_FAILURE_DETAIL_MAX_CHARS = 2000;

function formatProcessOutputDetail(label: string, value: string): string {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    const detail = text.length > PROCESS_FAILURE_DETAIL_MAX_CHARS
        ? `${text.slice(0, PROCESS_FAILURE_DETAIL_MAX_CHARS)}\n[${label} truncated at ${PROCESS_FAILURE_DETAIL_MAX_CHARS} chars]`
        : text;
    return `\n${label}:\n${detail}`;
}

function formatProcessFailureDetails(stdout: string, stderr: string): string {
    return `${formatProcessOutputDetail('stderr', stderr)}${formatProcessOutputDetail('stdout', stdout)}`;
}

export function buildSourceCloneArgs(repoUrl: string, branch: string | undefined, destinationPath: string): string[] {
    const cloneArgs = ['clone', '--quiet', '--depth', '1'];
    if (branch) {
        cloneArgs.push('--branch', String(branch).trim(), '--single-branch');
    }
    cloneArgs.push(String(repoUrl).trim(), destinationPath);
    return cloneArgs;
}

export async function runProcess(
    executableName: string,
    args: string[],
    options?: { cwd?: string; description?: string; interactive?: boolean; timeoutMs?: number }
): Promise<void> {
    const cwd = (options && options.cwd) || process.cwd();
    const description = (options && options.description) || executableName;
    const interactive = (options && options.interactive) || false;
    const timeoutMs = (options && options.timeoutMs) || 0;

    try {
        const result = await spawnStreamed(executableName, args, {
            cwd,
            timeoutMs,
            inheritStdio: interactive,
            onStdout: interactive ? undefined : (chunk) => process.stdout.write(chunk),
            onStderr: interactive ? undefined : (chunk) => process.stderr.write(chunk)
        });

        if (result.timedOut) {
            throw new Error(
                `${description} timed out after ${timeoutMs} ms.` +
                formatProcessFailureDetails(result.stdout, result.stderr)
            );
        }

        if (result.exitCode !== 0) {
            throw new Error(
                `${description} failed with exit code ${result.exitCode}.` +
                formatProcessFailureDetails(result.stdout, result.stderr)
            );
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('was not found in PATH')) {
            throw new Error(
                `'${executableName}' is not available on this system. ` +
                `Please install ${executableName} and ensure it is on your PATH.`
            );
        }
        throw error;
    }
}

export async function acquireSourceRoot(
    repoUrl: string | undefined,
    branch: string | undefined,
    packageRoot: string,
    options: {
        cloneTimeoutMs?: number;
        processRunner?: typeof runProcess;
    } = {}
): Promise<{ sourceRoot: string; bundleVersion: string; cleanup: () => void }> {
    if (!repoUrl && !branch) {
        return {
            sourceRoot: packageRoot,
            bundleVersion: readBundleVersion(packageRoot),
            cleanup: function () {}
        };
    }
    const effectiveRepoUrl = String(repoUrl || DEFAULT_REPO_URL).trim();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-source-'));
    const disposeSignalCleanup = registerTempRoot(tempRoot);
    try {
        const processRunner = options.processRunner || runProcess;
        await processRunner('git', buildSourceCloneArgs(effectiveRepoUrl, branch, tempRoot), {
            cwd: process.cwd(),
            description: `git clone from ${effectiveRepoUrl}`,
            timeoutMs: options.cloneTimeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS
        });
        return {
            sourceRoot: tempRoot,
            bundleVersion: readBundleVersion(tempRoot),
            cleanup: function () {
                disposeSignalCleanup();
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        };
    } catch (error) {
        disposeSignalCleanup();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        throw error;
    }
}
