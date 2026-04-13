import * as childProcess from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns, SpawnSyncOptions, StdioOptions } from 'node:child_process';

// ---------------------------------------------------------------------------
// Default timeout constants (milliseconds)
// ---------------------------------------------------------------------------

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;         // 60 s for routine git ops
export const DEFAULT_GIT_CLONE_TIMEOUT_MS = 300_000;  // 5 min for clone/fetch
export const DEFAULT_NPM_TIMEOUT_MS = 300_000;        // 5 min for npm operations
export const DEFAULT_COMPILE_TIMEOUT_MS = 600_000;    // 10 min for compile/test/lint

// ---------------------------------------------------------------------------
// spawnStreamed – async subprocess with streaming, timeout & cancellation
// ---------------------------------------------------------------------------

export interface SpawnStreamedOptions {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    inheritStdio?: boolean;
    maxBuffer?: number;
}

export interface SpawnStreamedResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}

function sliceChunkToFit(chunk: string, maxBytes: number): string {
    if (maxBytes <= 0 || chunk.length === 0) {
        return '';
    }

    let usedBytes = 0;
    let prefix = '';
    for (const symbol of chunk) {
        const symbolBytes = Buffer.byteLength(symbol, 'utf8');
        if (usedBytes + symbolBytes > maxBytes) {
            break;
        }
        prefix += symbol;
        usedBytes += symbolBytes;
    }
    return prefix;
}

function appendChunkWithinLimit(chunks: string[], chunk: string, currentBytes: number, maxBuffer: number): {
    nextBytes: number;
    truncated: boolean;
} {
    const remainingBytes = maxBuffer - currentBytes;
    if (remainingBytes <= 0) {
        return {
            nextBytes: currentBytes,
            truncated: true
        };
    }

    const fullBytes = Buffer.byteLength(chunk, 'utf8');
    if (fullBytes <= remainingBytes) {
        chunks.push(chunk);
        return {
            nextBytes: currentBytes + fullBytes,
            truncated: false
        };
    }

    const partial = sliceChunkToFit(chunk, remainingBytes);
    if (partial.length > 0) {
        chunks.push(partial);
        return {
            nextBytes: currentBytes + Buffer.byteLength(partial, 'utf8'),
            truncated: true
        };
    }

    return {
        nextBytes: currentBytes,
        truncated: true
    };
}

export function spawnStreamed(command: string, args: string[], options?: SpawnStreamedOptions): Promise<SpawnStreamedResult> {
    const opts = options || {};
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;
    const signal = opts.signal || null;
    const maxBuffer = opts.maxBuffer || 50 * 1024 * 1024;
    const inheritStdio = opts.inheritStdio || false;

    return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) {
            return resolve({
                exitCode: 1,
                stdout: '',
                stderr: '',
                timedOut: false,
                cancelled: true,
                stdoutTruncated: false,
                stderrTruncated: false
            });
        }

        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const spawnOpts: {
            cwd: string;
            windowsHide: boolean;
            stdio: StdioOptions;
            env?: NodeJS.ProcessEnv;
        } = {
            cwd,
            windowsHide: true,
            stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe']
        };
        if (opts.env) {
            spawnOpts.env = { ...process.env, ...opts.env };
        }

        const child: ChildProcess = childProcess.spawn(command, args, spawnOpts);

        function cleanup(): void {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        }

        function killChild(): void {
            try {
                if (process.platform === 'win32') {
                    try {
                        childProcess.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                            stdio: 'ignore',
                            windowsHide: true,
                            timeout: 5000
                        });
                    } catch (_e) {
                        child.kill('SIGKILL');
                    }
                } else {
                    child.kill('SIGTERM');
                    setTimeout(function () {
                        try { child.kill('SIGKILL'); } catch (_e) { /* already exited */ }
                    }, 3000);
                }
            } catch (_e) {
                // Child already exited
            }
        }

        function settle(result: SpawnStreamedResult): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function onAbort(): void {
            if (settled) return;
            cancelled = true;
            killChild();
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(function () {
                if (settled) return;
                timedOut = true;
                killChild();
            }, timeoutMs);
        }

        child.once('error', function (error: NodeJS.ErrnoException) {
            cleanup();
            if (settled) return;
            settled = true;
            if (error && error.code === 'ENOENT') {
                reject(new Error(`'${command}' is required but was not found in PATH.`));
            } else {
                reject(error);
            }
        });

        if (!inheritStdio) {
            if (child.stdout) {
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', function (chunk: string) {
                    const appendResult = appendChunkWithinLimit(stdoutChunks, chunk, stdoutBytes, maxBuffer);
                    stdoutBytes = appendResult.nextBytes;
                    stdoutTruncated = stdoutTruncated || appendResult.truncated;
                    if (opts.onStdout) {
                        opts.onStdout(chunk);
                    }
                });
            }
            if (child.stderr) {
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', function (chunk: string) {
                    const appendResult = appendChunkWithinLimit(stderrChunks, chunk, stderrBytes, maxBuffer);
                    stderrBytes = appendResult.nextBytes;
                    stderrTruncated = stderrTruncated || appendResult.truncated;
                    if (opts.onStderr) {
                        opts.onStderr(chunk);
                    }
                });
            }
        }

        child.once('close', function (code: number | null) {
            settle({
                exitCode: code == null ? 1 : code,
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
                timedOut,
                cancelled,
                stdoutTruncated,
                stderrTruncated
            });
        });
    });
}

// ---------------------------------------------------------------------------
// spawnShellCommand – internal allowlist helper for Windows batch files
// ---------------------------------------------------------------------------
// Shell execution is intentionally NOT exposed in the general-purpose
// SpawnStreamedOptions interface.  This helper confines shell semantics
// to the single scenario that genuinely requires them: running Windows
// .cmd/.bat executables where the OS needs cmd.exe to resolve the script.
//
// Callers must supply a fully pre-built command string; argument arrays are
// NOT accepted so that no user-controlled token can alter shell semantics.

export interface SpawnShellCommandOptions {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    maxBuffer?: number;
}

export function spawnShellCommand(
    commandLine: string,
    options?: SpawnShellCommandOptions
): Promise<SpawnStreamedResult> {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error(
            'spawnShellCommand is restricted to Windows batch-file execution. ' +
            'Use spawnStreamed for cross-platform commands.'
        ));
    }
    const opts = options || {};
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;
    const signal = opts.signal || null;
    const maxBuffer = opts.maxBuffer || 50 * 1024 * 1024;

    return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) {
            return resolve({
                exitCode: 1,
                stdout: '',
                stderr: '',
                timedOut: false,
                cancelled: true,
                stdoutTruncated: false,
                stderrTruncated: false
            });
        }

        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const child: ChildProcess = childProcess.spawn(commandLine, [], {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
        });

        function cleanup(): void {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        }

        function killChild(): void {
            try {
                try {
                    childProcess.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                        stdio: 'ignore',
                        windowsHide: true,
                        timeout: 5000
                    });
                } catch (_e) {
                    child.kill('SIGKILL');
                }
            } catch (_e) {
                // Child already exited
            }
        }

        function settle(result: SpawnStreamedResult): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function onAbort(): void {
            if (settled) return;
            cancelled = true;
            killChild();
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(function () {
                if (settled) return;
                timedOut = true;
                killChild();
            }, timeoutMs);
        }

        child.once('error', function (error: NodeJS.ErrnoException) {
            cleanup();
            if (settled) return;
            settled = true;
            reject(error);
        });

        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (chunk: string) {
                const appendResult = appendChunkWithinLimit(stdoutChunks, chunk, stdoutBytes, maxBuffer);
                stdoutBytes = appendResult.nextBytes;
                stdoutTruncated = stdoutTruncated || appendResult.truncated;
                if (opts.onStdout) {
                    opts.onStdout(chunk);
                }
            });
        }
        if (child.stderr) {
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (chunk: string) {
                const appendResult = appendChunkWithinLimit(stderrChunks, chunk, stderrBytes, maxBuffer);
                stderrBytes = appendResult.nextBytes;
                stderrTruncated = stderrTruncated || appendResult.truncated;
                if (opts.onStderr) {
                    opts.onStderr(chunk);
                }
            });
        }

        child.once('close', function (code: number | null) {
            settle({
                exitCode: code == null ? 1 : code,
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
                timedOut,
                cancelled,
                stdoutTruncated,
                stderrTruncated
            });
        });
    });
}

// ---------------------------------------------------------------------------
// spawnSyncWithTimeout – thin wrapper adding timeout to spawnSync
// ---------------------------------------------------------------------------

export interface SpawnSyncWithTimeoutOptions extends SpawnSyncOptions {
    timeoutMs?: number;
}

export interface SpawnSyncWithTimeoutResult extends SpawnSyncReturns<string> {
    timedOut: boolean;
}

export function spawnSyncWithTimeout(command: string, args: string[], options?: SpawnSyncWithTimeoutOptions): SpawnSyncWithTimeoutResult {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 0;
    const passThrough: SpawnSyncOptions & { timeoutMs?: number } = { ...opts };
    delete passThrough.timeoutMs;

    if (timeoutMs > 0) {
        passThrough.timeout = timeoutMs;
    }
    if (passThrough.windowsHide === undefined) {
        passThrough.windowsHide = true;
    }

    const result = childProcess.spawnSync(command, args, passThrough) as SpawnSyncWithTimeoutResult;

    // spawnSync sets result.signal === 'SIGTERM' on timeout
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        result.timedOut = true;
    } else if (result.signal === 'SIGTERM' && timeoutMs > 0) {
        result.timedOut = true;
    } else {
        result.timedOut = false;
    }

    return result;
}
