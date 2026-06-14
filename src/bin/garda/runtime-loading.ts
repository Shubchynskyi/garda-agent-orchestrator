import * as fs from 'node:fs';
import * as path from 'node:path';

import { PRODUCT_NAME } from './launcher-constants';
import { looksLikeSourceCheckout } from './root-discovery';

export interface CliMainModule {
    runCliMainWithHandling: (argv?: string[], packageRoot?: string) => Promise<void>;
}

const RUNTIME_LOAD_LOCK_TIMEOUT_ENV = 'GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS';
const RUNTIME_LOAD_LOCK_POLL_MS = 50;
const RUNTIME_LOAD_RETRY_DELAY_MS = 50;
const RUNTIME_LOAD_MAX_ATTEMPTS = 3;

function hasRuntimeRoot(runtimeRoot: string): boolean {
    return fs.existsSync(path.join(runtimeRoot, 'index.js'));
}

function isRecoverableLoadError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function getRuntimeBuildLockPath(runtimeRoot: string): string {
    return `${path.dirname(runtimeRoot)}.lock`;
}

function computeDeadline(timeoutMs: number): number {
    return Date.now() + timeoutMs;
}

function getRemainingMilliseconds(deadline: number): number {
    return Math.max(0, deadline - Date.now());
}

function waitForRuntimeBuildLock(runtimeRoot: string, deadline: number): boolean {
    const lockPath = getRuntimeBuildLockPath(runtimeRoot);
    if (!fs.existsSync(lockPath)) {
        return false;
    }

    while (fs.existsSync(lockPath)) {
        const remainingMs = getRemainingMilliseconds(deadline);
        if (remainingMs <= 0) {
            throw new Error(
                `Timed out waiting for ${PRODUCT_NAME} runtime build lock to clear: ${lockPath}`
            );
        }
        sleepSync(Math.min(RUNTIME_LOAD_LOCK_POLL_MS, remainingMs));
    }

    return true;
}

function clearRuntimeRequireCache(runtimeRoot: string): void {
    const normalizedRoot = path.resolve(runtimeRoot) + path.sep;
    for (const cachedPath of Object.keys(require.cache)) {
        if (path.resolve(cachedPath).startsWith(normalizedRoot)) {
            delete require.cache[cachedPath];
        }
    }
}

export function getRuntimeCandidates(packageRoot: string): string[] {
    const devBuildRuntimeRoot = path.join(packageRoot, '.node-build', 'src');
    const publishRuntimeRoot = path.join(packageRoot, 'dist', 'src');
    const candidates: string[] = [];

    if (hasRuntimeRoot(publishRuntimeRoot)) {
        candidates.push(publishRuntimeRoot);
    }

    if (looksLikeSourceCheckout(packageRoot) && hasRuntimeRoot(devBuildRuntimeRoot)) {
        candidates.push(devBuildRuntimeRoot);
    }

    return candidates;
}

export function loadCliMainModule(packageRoot: string): CliMainModule {
    const runtimeCandidates = getRuntimeCandidates(packageRoot);
    if (runtimeCandidates.length === 0) {
        console.error(
            `${PRODUCT_NAME} runtime build output not found.\n`
            + 'Run "npm run build" to compile TypeScript sources before execution.'
        );
        process.exit(1);
    }

    let lastError: unknown = null;

    for (let index = 0; index < runtimeCandidates.length; index += 1) {
        const runtimeRoot = runtimeCandidates[index];
        const runtimeLoadDeadline = computeDeadline(
            parsePositiveInteger(process.env[RUNTIME_LOAD_LOCK_TIMEOUT_ENV], 120_000)
        );
        for (let attempt = 0; attempt < RUNTIME_LOAD_MAX_ATTEMPTS; attempt += 1) {
            waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
            try {
                return require(path.join(runtimeRoot, 'cli', 'main.js')) as CliMainModule;
            } catch (error: unknown) {
                lastError = error;
                const recoverable = isRecoverableLoadError(error);
                const hasFallback = index < runtimeCandidates.length - 1;
                if (!recoverable) {
                    throw error;
                }
                clearRuntimeRequireCache(runtimeRoot);
                if (attempt < RUNTIME_LOAD_MAX_ATTEMPTS - 1) {
                    waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
                    const remainingMs = getRemainingMilliseconds(runtimeLoadDeadline);
                    if (remainingMs <= 0) {
                        if (hasFallback) {
                            break;
                        }
                        throw error;
                    }
                    sleepSync(Math.min(RUNTIME_LOAD_RETRY_DELAY_MS, remainingMs));
                    continue;
                }
                if (!hasFallback) {
                    throw error;
                }
                break;
            }
        }
    }

    throw lastError;
}

