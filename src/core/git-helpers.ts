import * as childProcess from 'node:child_process';

export interface RunGitOptions {
    allowFailure?: boolean;
    maxBuffer?: number;
    timeoutMs?: number;
}

function isGitTimeoutError(error: unknown): boolean {
    const details = error as NodeJS.ErrnoException & { killed?: boolean };
    return details?.code === 'ETIMEDOUT' || details?.killed === true;
}

export function runGit(repoRoot: string, args: string[], options: RunGitOptions = {}): string {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: options.maxBuffer,
            timeout: options.timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (options.allowFailure && !isGitTimeoutError(error)) {
            return '';
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`git ${args.join(' ')} failed: ${message}`);
    }
}

export function runGitBinary(
    repoRoot: string,
    args: string[],
    options: Pick<RunGitOptions, 'allowFailure' | 'maxBuffer' | 'timeoutMs'> = {}
): Buffer {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            maxBuffer: options.maxBuffer,
            timeout: options.timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (options.allowFailure && !isGitTimeoutError(error)) {
            return Buffer.alloc(0);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`git ${args.join(' ')} failed: ${message}`);
    }
}

export function splitNulList(value: string | Buffer): string[] {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    return text.split('\0').map((entry) => entry.trim()).filter(Boolean);
}
