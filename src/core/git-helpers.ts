import * as childProcess from 'node:child_process';

export interface RunGitOptions {
    allowFailure?: boolean;
    maxBuffer?: number;
}

export function runGit(repoRoot: string, args: string[], options: RunGitOptions = {}): string {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: options.maxBuffer,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (options.allowFailure) {
            return '';
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`git ${args.join(' ')} failed: ${message}`);
    }
}

export function runGitBinary(
    repoRoot: string,
    args: string[],
    options: Pick<RunGitOptions, 'allowFailure' | 'maxBuffer'> = {}
): Buffer {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            maxBuffer: options.maxBuffer,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (options.allowFailure) {
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
