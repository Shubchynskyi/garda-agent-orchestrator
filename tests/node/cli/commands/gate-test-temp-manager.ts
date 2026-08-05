/**
 * Run-scoped temporary directory management for CLI tests.
 *
 * Every test worker owns one marked run root. Normal assertion failures are
 * covered by node:test hooks, while a later worker can reclaim roots whose
 * owner process was killed before its hooks ran.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, type TestContext } from 'node:test';

const TRANSIENT_CLEANUP_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const DEFAULT_CLEANUP_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_600];
const DEFAULT_UNKNOWN_OWNER_GRACE_MS = 10 * 60 * 1000;
const RUN_ROOT_PREFIX = 'run-';

export const CLI_TEST_TEMP_OWNER_FILE = '.owner.json';

export interface RemoveTempRepoOptions {
    readonly rmSync?: typeof fs.rmSync;
    readonly retryDelaysMs?: readonly number[];
}

export interface TestCleanupContext {
    after(callback: () => void): void;
}

interface CliTestTempOwner {
    readonly schema_version: 1;
    readonly process_id: number;
    readonly hostname: string;
    readonly created_at_utc: string;
}

export interface CliTestTempManagerOptions {
    readonly baseRoot?: string;
    readonly processId?: number;
    readonly hostname?: string;
    readonly now?: () => number;
    readonly isProcessAlive?: (processId: number) => boolean;
    readonly removeDirectory?: (root: string) => void;
    readonly unknownOwnerGraceMs?: number;
}

function getErrorCode(error: unknown): string {
    return String((error as NodeJS.ErrnoException | undefined)?.code || '');
}

function sleepSync(delayMs: number): void {
    if (delayMs <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isTransientCleanupError(error: unknown): boolean {
    return TRANSIENT_CLEANUP_ERROR_CODES.has(getErrorCode(error));
}

function isMissingPathError(error: unknown): boolean {
    return getErrorCode(error) === 'ENOENT';
}

function defaultIsProcessAlive(processId: number): boolean {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
        return false;
    }
    if (processId === process.pid) {
        return true;
    }
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        return getErrorCode(error) === 'EPERM';
    }
}

function normalizeDirectoryPrefix(prefix: string): string {
    const normalized = prefix.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+$/g, '');
    return `${normalized || 'case'}-`;
}

function throwCleanupErrors(errors: unknown[], message: string): void {
    if (errors.length === 0) {
        return;
    }
    if (errors.length === 1) {
        throw errors[0];
    }
    throw new AggregateError(errors, message);
}

export function removeTempRepoWithRetry(root: string, options: RemoveTempRepoOptions = {}): void {
    const rmSync = options.rmSync || fs.rmSync;
    const retryDelaysMs = options.retryDelaysMs || DEFAULT_CLEANUP_RETRY_DELAYS_MS;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
            rmSync(root, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!isTransientCleanupError(error)) {
                throw error;
            }
            lastError = error;
            if (attempt === retryDelaysMs.length) {
                break;
            }
            sleepSync(retryDelaysMs[attempt] || 0);
        }
    }

    throw lastError;
}

export class CliTestTempManager {
    private readonly baseRoot: string;
    private readonly processId: number;
    private readonly hostname: string;
    private readonly now: () => number;
    private readonly isProcessAlive: (processId: number) => boolean;
    private readonly removeDirectory: (root: string) => void;
    private readonly unknownOwnerGraceMs: number;
    private readonly trackedDirectories = new Set<string>();
    private runRoot: string | null = null;
    private staleRunCleanupComplete = false;

    constructor(options: CliTestTempManagerOptions = {}) {
        this.baseRoot = options.baseRoot || path.join(os.tmpdir(), 'garda-cli-tests');
        this.processId = options.processId ?? process.pid;
        this.hostname = options.hostname || os.hostname();
        this.now = options.now || Date.now;
        this.isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
        this.removeDirectory = options.removeDirectory || removeTempRepoWithRetry;
        this.unknownOwnerGraceMs = options.unknownOwnerGraceMs ?? DEFAULT_UNKNOWN_OWNER_GRACE_MS;
    }

    createDirectory(prefix = 'case-', testContext?: TestCleanupContext): string {
        const runRoot = this.ensureRunRoot();
        const directory = fs.mkdtempSync(path.join(runRoot, normalizeDirectoryPrefix(prefix)));
        this.trackedDirectories.add(directory);
        if (testContext) {
            testContext.after(() => {
                this.cleanupDirectory(directory);
            });
        }
        return directory;
    }

    createRunScopedDirectory(prefix = 'shared-'): string {
        const runRoot = this.ensureRunRoot();
        return fs.mkdtempSync(path.join(runRoot, normalizeDirectoryPrefix(prefix)));
    }

    cleanupDirectory(directory: string): void {
        this.removeDirectory(directory);
        this.trackedDirectories.delete(directory);
    }

    cleanupTrackedDirectories(): void {
        const errors: unknown[] = [];
        for (const directory of Array.from(this.trackedDirectories)) {
            try {
                this.cleanupDirectory(directory);
            } catch (error) {
                errors.push(error);
            }
        }
        throwCleanupErrors(errors, 'Failed to clean one or more CLI test temporary directories.');
    }

    cleanupRunRoot(): void {
        const errors: unknown[] = [];
        try {
            this.cleanupTrackedDirectories();
        } catch (error) {
            errors.push(error);
        }
        if (this.runRoot !== null) {
            try {
                this.removeDirectory(this.runRoot);
                this.runRoot = null;
            } catch (error) {
                errors.push(error);
            }
        }
        throwCleanupErrors(errors, 'Failed to clean the CLI test run root.');
    }

    private ensureRunRoot(): string {
        if (this.runRoot !== null) {
            return this.runRoot;
        }
        fs.mkdirSync(this.baseRoot, { recursive: true });
        this.cleanupStaleRunRoots();
        const runRoot = fs.mkdtempSync(path.join(this.baseRoot, RUN_ROOT_PREFIX));
        const owner: CliTestTempOwner = {
            schema_version: 1,
            process_id: this.processId,
            hostname: this.hostname,
            created_at_utc: new Date(this.now()).toISOString()
        };
        try {
            fs.writeFileSync(
                path.join(runRoot, CLI_TEST_TEMP_OWNER_FILE),
                `${JSON.stringify(owner, null, 2)}\n`,
                'utf8'
            );
        } catch (error) {
            try {
                this.removeDirectory(runRoot);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    'Failed to initialize and clean a CLI test run root.'
                );
            }
            throw error;
        }
        this.runRoot = runRoot;
        return runRoot;
    }

    private cleanupStaleRunRoots(): void {
        if (this.staleRunCleanupComplete) {
            return;
        }
        const errors: unknown[] = [];
        for (const entry of fs.readdirSync(this.baseRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(RUN_ROOT_PREFIX)) {
                continue;
            }
            const candidate = path.join(this.baseRoot, entry.name);
            try {
                if (this.isStaleRunRoot(candidate)) {
                    this.removeDirectory(candidate);
                }
            } catch (error) {
                if (!isMissingPathError(error)) {
                    errors.push(error);
                }
            }
        }
        throwCleanupErrors(errors, 'Failed to clean stale CLI test run roots.');
        this.staleRunCleanupComplete = true;
    }

    private isStaleRunRoot(candidate: string): boolean {
        const owner = this.readOwner(candidate);
        if (
            owner !== null
            && owner.hostname === this.hostname
            && this.isProcessAlive(owner.process_id)
        ) {
            return false;
        }
        if (owner !== null && owner.hostname === this.hostname) {
            return true;
        }
        const ageMs = Math.max(0, this.now() - fs.statSync(candidate).mtimeMs);
        return ageMs >= this.unknownOwnerGraceMs;
    }

    private readOwner(candidate: string): CliTestTempOwner | null {
        try {
            const parsed = JSON.parse(
                fs.readFileSync(path.join(candidate, CLI_TEST_TEMP_OWNER_FILE), 'utf8')
            ) as Partial<CliTestTempOwner>;
            if (
                parsed.schema_version !== 1
                || !Number.isSafeInteger(parsed.process_id)
                || Number(parsed.process_id) <= 0
                || typeof parsed.hostname !== 'string'
                || typeof parsed.created_at_utc !== 'string'
            ) {
                return null;
            }
            return parsed as CliTestTempOwner;
        } catch (error) {
            if (isMissingPathError(error) || error instanceof SyntaxError) {
                return null;
            }
            throw error;
        }
    }
}

const sharedCliTestTempManager = new CliTestTempManager();

after(() => {
    sharedCliTestTempManager.cleanupRunRoot();
});

export function createManagedTestTempDirectory(
    prefix = 'case-',
    testContext?: Pick<TestContext, 'after'>
): string {
    return sharedCliTestTempManager.createDirectory(prefix, testContext);
}

export function createRunScopedTestTempDirectory(prefix = 'shared-'): string {
    return sharedCliTestTempManager.createRunScopedDirectory(prefix);
}

export function removeManagedTestTempDirectory(directory: string): void {
    sharedCliTestTempManager.cleanupDirectory(directory);
}
