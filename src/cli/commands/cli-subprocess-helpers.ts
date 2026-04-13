import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerTempRoot } from '../signal-handler';
import { DEFAULT_REPO_URL } from './cli-constants';
import { readBundleVersion } from './cli-bundle-helpers';

function createMissingExecutableError(executableName: string): Error {
    return new Error(
        `'${executableName}' is not available on this system. ` +
        `Please install ${executableName} and ensure it is on your PATH.`
    );
}

export function runProcess(
    executableName: string,
    args: string[],
    options?: { cwd?: string; description?: string; interactive?: boolean }
): Promise<void> {
    const cwd = (options && options.cwd) || process.cwd();
    const description = (options && options.description) || executableName;
    const interactive = (options && options.interactive) || false;
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const child = childProcess.spawn(executableName, args, {
            cwd,
            windowsHide: true,
            stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe']
        });
        const rejectOnce = (error: Error): void => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        const resolveOnce = (): void => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        child.once('error', (error: Error): void => {
            const errno = error as NodeJS.ErrnoException;
            if (errno.code === 'ENOENT') {
                rejectOnce(createMissingExecutableError(executableName));
                return;
            }
            rejectOnce(error);
        });
        if (!interactive) {
            if (child.stdout) {
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string): void => { process.stdout.write(chunk); });
            }
            if (child.stderr) {
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk: string): void => { process.stderr.write(chunk); });
            }
        }
        child.once('close', (code: number | null): void => {
            if (code !== 0) {
                rejectOnce(new Error(`${description} failed with exit code ${code}.`));
                return;
            }
            resolveOnce();
        });
    });
}

export async function acquireSourceRoot(
    repoUrl: string | undefined,
    branch: string | undefined,
    packageRoot: string
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
        const cloneArgs = ['clone', '--quiet', '--depth', '1'];
        if (branch) {
            cloneArgs.push('--branch', String(branch).trim(), '--single-branch');
        }
        cloneArgs.push(effectiveRepoUrl, tempRoot);
        await runProcess('git', cloneArgs, { cwd: process.cwd(), description: `git clone from ${effectiveRepoUrl}` });
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
