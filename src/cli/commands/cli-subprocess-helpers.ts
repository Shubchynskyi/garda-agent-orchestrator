import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnStreamed } from '../../core/subprocess';
import { registerTempRoot } from '../signal-handler';
import { DEFAULT_REPO_URL } from './cli-constants';
import { readBundleVersion } from './cli-bundle-helpers';

export async function runProcess(
    executableName: string,
    args: string[],
    options?: { cwd?: string; description?: string; interactive?: boolean }
): Promise<void> {
    const cwd = (options && options.cwd) || process.cwd();
    const description = (options && options.description) || executableName;
    const interactive = (options && options.interactive) || false;

    try {
        const result = await spawnStreamed(executableName, args, {
            cwd,
            inheritStdio: interactive,
            onStdout: interactive ? undefined : (chunk) => process.stdout.write(chunk),
            onStderr: interactive ? undefined : (chunk) => process.stderr.write(chunk)
        });

        if (result.exitCode !== 0) {
            throw new Error(`${description} failed with exit code ${result.exitCode}.`);
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
