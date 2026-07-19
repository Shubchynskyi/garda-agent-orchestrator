import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../../core/constants';
import { validateProfilesConfig } from '../../../schemas/config-artifacts';
import { writeTextFileAtomically } from '../../../core/filesystem';
import { normalizePathValue } from '../cli-helpers';
import { ParsedOptionsRecord, ProfileEntry, ProfilesData } from './profile-types';

const PROFILE_LOCK_MAX_ATTEMPTS = 26;
const PROFILE_LOCK_RETRY_DELAY_MS = 8;
const MALFORMED_PROFILE_LOCK_MIN_AGE_MS = 1_000;
const MALFORMED_CLEANUP_LOCK_MIN_AGE_MS = 1_000;

export class ProfilesConfigLockAcquisitionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProfilesConfigLockAcquisitionError';
    }
}

export class ProfilesConfigLockReleaseError extends Error {
    operationResult: unknown = undefined;

    constructor(message: string, readonly operationCompleted: boolean, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProfilesConfigLockReleaseError';
    }
}

export function getCompletedProfilesOperationResult<T>(error: unknown): { result: T } | null {
    if (!(error instanceof ProfilesConfigLockReleaseError) || !error.operationCompleted) return null;
    return { result: error.operationResult as T };
}

export function resolveBundleRoot(options: ParsedOptionsRecord): { targetRoot: string; bundleRoot: string } {
    const explicitTargetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : null;
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = explicitTargetRoot || (explicitBundleRoot ? path.dirname(explicitBundleRoot) : normalizePathValue('.'));
    const bundleRoot = explicitBundleRoot || path.join(targetRoot, resolveBundleName());
    return { targetRoot, bundleRoot };
}

export function resolveProfilesPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'profiles.json');
}

function assertProfilesDirectoryBoundary(profilesPath: string): void {
    const configDirectory = path.dirname(profilesPath);
    const liveDirectory = path.dirname(configDirectory);
    const bundleRoot = path.dirname(liveDirectory);
    for (const directoryPath of [liveDirectory, configDirectory]) {
        const identity = fs.lstatSync(directoryPath);
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error('Profiles config directory must be a real directory inside the bundle.');
        }
    }
    const realBundleRoot = fs.realpathSync.native(bundleRoot);
    const expectedConfigDirectory = path.join(realBundleRoot, path.basename(liveDirectory), path.basename(configDirectory));
    if (path.resolve(fs.realpathSync.native(configDirectory)) !== path.resolve(expectedConfigDirectory)) {
        throw new Error('Profiles config directory resolves outside the bundle.');
    }
}

export function readProfilesData(profilesPath: string): ProfilesData {
    if (!fs.existsSync(profilesPath)) {
        throw new Error(`Profiles config not found: ${profilesPath}`);
    }
    const profilesFd = openExistingProfilesConfig(profilesPath);
    let raw: string;
    try {
        raw = fs.readFileSync(profilesFd, 'utf8');
    } finally {
        fs.closeSync(profilesFd);
    }
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateProfilesConfig(parsed) as unknown as ProfilesData;
    return validated;
}

export function writeProfilesDataUnlocked(profilesPath: string, data: ProfilesData): void {
    const profilesFd = openExistingProfilesConfig(profilesPath);
    fs.closeSync(profilesFd);
    const validated = validateProfilesConfig(data) as unknown as ProfilesData;
    writeTextFileAtomically(profilesPath, JSON.stringify(validated, null, 2), {
        trailingNewline: true,
        fsync: true
    });
}

type ProfilesLockRelease = (operationCompleted: boolean) => void;

function acquireProfilesLock(lockPath: string): number {
    let lockFd: number | null = null;
    for (let attempt = 0; attempt < PROFILE_LOCK_MAX_ATTEMPTS && lockFd === null; attempt += 1) {
        try {
            lockFd = createProfilesLock(lockPath);
        } catch (error: unknown) {
            if (removeDeadProfilesLock(lockPath)) continue;
            const errorCode = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
            if (errorCode === 'EEXIST' && attempt + 1 < PROFILE_LOCK_MAX_ATTEMPTS) {
                waitForProfilesLockRetry();
                continue;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ProfilesConfigLockAcquisitionError(`Could not acquire profiles config lock: ${message}`, {
                cause: error
            });
        }
    }
    if (lockFd === null) throw new ProfilesConfigLockAcquisitionError('Could not acquire profiles config lock.');
    return lockFd;
}

function failProfilesOperation(error: unknown, release: ProfilesLockRelease): never {
    try {
        release(false);
    } catch (releaseError: unknown) {
        throw new AggregateError(
            [error, releaseError],
            'Profiles operation and config lock release both failed.'
        );
    }
    throw error;
}

function settleProfilesOperation<T>(result: T, release: ProfilesLockRelease): T {
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(result).then(
            (value) => {
                try {
                    release(true);
                } catch (error: unknown) {
                    if (error instanceof ProfilesConfigLockReleaseError) error.operationResult = value;
                    throw error;
                }
                return value;
            },
            (operationError: unknown) => failProfilesOperation(operationError, release)
        ) as T;
    }
    try {
        release(true);
    } catch (error: unknown) {
        if (error instanceof ProfilesConfigLockReleaseError) error.operationResult = result;
        throw error;
    }
    return result;
}

export function withProfilesDataLock<T>(profilesPath: string, operation: () => T): T {
    if (!fs.existsSync(profilesPath)) {
        throw new Error(`Profiles config not found: ${profilesPath}`);
    }
    assertProfilesDirectoryBoundary(profilesPath);
    const lockPath = `${profilesPath}.garda-write.lock`;
    const lockFd = acquireProfilesLock(lockPath);
    let released = false;
    const release = (operationCompleted: boolean): void => {
        if (released) return;
        released = true;
        releaseProfilesLock(lockPath, lockFd, operationCompleted);
    };
    try {
        return settleProfilesOperation(operation(), release);
    } catch (error: unknown) {
        if (released) throw error;
        return failProfilesOperation(error, release);
    }
}

function releaseProfilesLock(lockPath: string, lockFd: number, operationCompleted: boolean): void {
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    const cleanupFd = acquireProfilesCleanupLock(cleanupPath);
    let lockClosed = false;
    let releaseFailure: unknown = null;
    try {
        if (cleanupFd === null) {
            markProfilesLockReleased(lockFd);
        } else {
            const ownedIdentity = fs.fstatSync(lockFd);
            const currentIdentity = fs.lstatSync(lockPath);
            fs.closeSync(lockFd);
            lockClosed = true;
            if (currentIdentity.dev === ownedIdentity.dev && currentIdentity.ino === ownedIdentity.ino) {
                fs.unlinkSync(lockPath);
            }
        }
    } catch (error: unknown) {
        releaseFailure = error;
    } finally {
        if (!lockClosed) {
            try { fs.closeSync(lockFd); } catch (error: unknown) { releaseFailure ||= error; }
        }
        if (cleanupFd !== null) {
            const cleanupFailure = releaseOwnedCleanupGuard(cleanupPath, cleanupFd);
            releaseFailure ||= cleanupFailure;
        }
    }
    if (releaseFailure !== null) {
        const message = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
        throw new ProfilesConfigLockReleaseError(
            `Could not release profiles config lock: ${message}`,
            operationCompleted,
            { cause: releaseFailure }
        );
    }
}

function releaseOwnedCleanupGuard(cleanupPath: string, cleanupFd: number): unknown | null {
    let identity: fs.Stats | null = null;
    let failure: unknown | null = null;
    try { identity = fs.fstatSync(cleanupFd); } catch (error: unknown) { failure = error; }
    if (identity) {
        try { markProfilesLockReleased(cleanupFd); } catch (error: unknown) { failure ||= error; }
    }
    try { fs.closeSync(cleanupFd); } catch (error: unknown) { failure ||= error; }
    if (identity) {
        try {
            if (!unlinkObservedPath(cleanupPath, identity)) {
                failure ||= new Error('Profiles cleanup lock path changed before release.');
            }
        } catch (error: unknown) {
            failure ||= error;
        }
    }
    return failure;
}

function markProfilesLockReleased(lockFd: number): void {
    fs.ftruncateSync(lockFd, 0);
    fs.writeSync(lockFd, JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString(),
        released: true,
        released_at_utc: new Date().toISOString()
    }), 0, 'utf8');
    fs.fsyncSync(lockFd);
}

function waitForProfilesLockRetry(): void {
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(signal, 0, 0, PROFILE_LOCK_RETRY_DELAY_MS);
}

function openPathWithoutFollowing(filePath: string, flags: number): number {
    return fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW);
}

function openExistingProfilesConfig(profilesPath: string): number {
    assertProfilesDirectoryBoundary(profilesPath);
    const initialIdentity = fs.lstatSync(profilesPath);
    if (!initialIdentity.isFile() || initialIdentity.isSymbolicLink()) {
        throw new Error('Profiles config must be a regular file inside the bundle.');
    }
    if (initialIdentity.nlink !== 1) {
        throw new Error('Profiles config must not have additional hard links.');
    }
    const profilesFd = openPathWithoutFollowing(profilesPath, fs.constants.O_RDONLY);
    try {
        const openedIdentity = fs.fstatSync(profilesFd);
        const pathIdentity = fs.lstatSync(profilesPath);
        if (!openedIdentity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()) {
            throw new Error('Profiles config must be a regular file inside the bundle.');
        }
        if (openedIdentity.nlink !== 1 || pathIdentity.nlink !== 1) {
            throw new Error('Profiles config must not have additional hard links.');
        }
        if (
            openedIdentity.dev !== initialIdentity.dev
            || openedIdentity.ino !== initialIdentity.ino
            || openedIdentity.dev !== pathIdentity.dev
            || openedIdentity.ino !== pathIdentity.ino
        ) {
            throw new Error('Profiles config path changed while it was opened.');
        }
        assertProfilesDirectoryBoundary(profilesPath);
        return profilesFd;
    } catch (error: unknown) {
        fs.closeSync(profilesFd);
        throw error;
    }
}

function assertOpenedPathIdentity(filePath: string, fd: number, expectedIdentity?: fs.Stats): fs.Stats {
    const openedIdentity = fs.fstatSync(fd);
    const pathIdentity = fs.lstatSync(filePath);
    if (!openedIdentity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()) {
        throw new Error('Profiles config lock must be a regular file.');
    }
    if (openedIdentity.dev !== pathIdentity.dev || openedIdentity.ino !== pathIdentity.ino) {
        throw new Error('Profiles config lock path changed while it was opened.');
    }
    if (expectedIdentity && (
        openedIdentity.dev !== expectedIdentity.dev || openedIdentity.ino !== expectedIdentity.ino
    )) {
        throw new Error('Profiles config lock does not match the prepared owner file.');
    }
    return openedIdentity;
}

function openExistingProfilesLock(filePath: string, flags: number): number {
    const fd = openPathWithoutFollowing(filePath, flags);
    try {
        const identity = assertOpenedPathIdentity(filePath, fd);
        if (identity.nlink !== 1) throw new Error('Profiles config lock must not have additional hard links.');
        return fd;
    } catch (error: unknown) {
        fs.closeSync(fd);
        throw error;
    }
}

function createProfilesLock(lockPath: string): number {
    return createOwnedProfilesLock(lockPath, {
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    });
}

function createOwnedProfilesLock(lockPath: string, owner: Record<string, unknown>): number {
    let lockFd: number | null = null;
    let lockIdentity: fs.Stats | null = null;
    try {
        const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR;
        lockFd = openPathWithoutFollowing(lockPath, flags);
        fs.writeFileSync(lockFd, JSON.stringify(owner));
        fs.fsyncSync(lockFd);
        lockIdentity = assertOpenedPathIdentity(lockPath, lockFd);
        if (lockIdentity.nlink !== 1) {
            throw new Error('Profiles config lock must not have additional hard links.');
        }
        const result = lockFd;
        lockFd = null;
        return result;
    } catch (error: unknown) {
        if (lockFd !== null) {
            try { lockIdentity ||= fs.fstatSync(lockFd); } catch { /* descriptor may be invalid */ }
            try { fs.closeSync(lockFd); } catch { /* best-effort descriptor cleanup */ }
        }
        if (lockIdentity) {
            try { unlinkObservedPath(lockPath, lockIdentity); } catch { /* uncertain ownership remains fail-closed */ }
        }
        throw error;
    }
}

function removeDeadProfilesLock(lockPath: string): boolean {
    const cleanupPath = `${lockPath}.dead-owner-cleanup`;
    const cleanupFd = acquireProfilesCleanupLock(cleanupPath);
    if (cleanupFd === null) return false;
    let removed = false;
    try {
        removed = tryRemoveDeadProfilesLock(lockPath);
    } catch {
        removed = false;
    }
    const cleanupFailure = releaseOwnedCleanupGuard(cleanupPath, cleanupFd);
    if (cleanupFailure) {
        const message = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
        throw new ProfilesConfigLockAcquisitionError(
            `Could not release profiles dead-owner cleanup guard: ${message}`,
            { cause: cleanupFailure }
        );
    }
    return removed;
}

function tryRemoveDeadProfilesLock(lockPath: string): boolean {
    const lockFd = openExistingProfilesLock(lockPath, fs.constants.O_RDONLY);
    let observedIdentity: fs.Stats;
    let owner: Record<string, unknown>;
    try {
        observedIdentity = fs.fstatSync(lockFd);
        try {
            owner = readProfilesLockOwner(lockFd);
        } catch {
            return removeAgedMalformedLock(lockPath, observedIdentity, MALFORMED_PROFILE_LOCK_MIN_AGE_MS);
        }
    } finally {
        fs.closeSync(lockFd);
    }
    const pid = Number(owner.pid);
    const explicitlyReleased = owner.released === true;
    if (!explicitlyReleased && (!Number.isSafeInteger(pid) || pid <= 0)) {
        return removeAgedMalformedLock(lockPath, observedIdentity, MALFORMED_PROFILE_LOCK_MIN_AGE_MS);
    }
    if (!explicitlyReleased && isProcessAlive(pid)) return false;
    return unlinkObservedPath(lockPath, observedIdentity);
}

function acquireProfilesCleanupLock(cleanupPath: string): number | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return createProfilesCleanupLock(cleanupPath);
        } catch (error: unknown) {
            const errorCode = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
            if (attempt === 0 && errorCode === 'EEXIST' && removeDeadCleanupLock(cleanupPath)) continue;
            return null;
        }
    }
    return null;
}

function createProfilesCleanupLock(cleanupPath: string): number {
    return createOwnedProfilesLock(cleanupPath, {
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    });
}

function removeDeadCleanupLock(cleanupPath: string): boolean {
    try {
        const cleanupFd = openExistingProfilesLock(cleanupPath, fs.constants.O_RDONLY);
        let observedIdentity: fs.Stats;
        let owner: Record<string, unknown>;
        try {
            observedIdentity = fs.fstatSync(cleanupFd);
            try {
                owner = readProfilesLockOwner(cleanupFd);
            } catch {
                return removeAgedMalformedLock(cleanupPath, observedIdentity, MALFORMED_CLEANUP_LOCK_MIN_AGE_MS);
            }
        } finally {
            fs.closeSync(cleanupFd);
        }
        const pid = Number(owner.pid);
        const explicitlyReleased = owner.released === true;
        if (!explicitlyReleased && (!Number.isSafeInteger(pid) || pid <= 0)) {
            return removeAgedMalformedLock(cleanupPath, observedIdentity, MALFORMED_CLEANUP_LOCK_MIN_AGE_MS);
        }
        if (!explicitlyReleased && isProcessAlive(pid)) return false;
        return unlinkObservedPath(cleanupPath, observedIdentity);
    } catch {
        return false;
    }
}

function readProfilesLockOwner(lockFd: number): Record<string, unknown> {
    const parsed = JSON.parse(fs.readFileSync(lockFd, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Profiles config lock owner metadata must be an object.');
    }
    return parsed as Record<string, unknown>;
}

function removeAgedMalformedLock(lockPath: string, identity: fs.Stats, minimumAgeMs: number): boolean {
    if (Date.now() - identity.mtimeMs < minimumAgeMs) return false;
    return unlinkObservedPath(lockPath, identity);
}

function unlinkObservedPath(filePath: string, observedIdentity: fs.Stats): boolean {
    const currentIdentity = fs.lstatSync(filePath);
    if (!currentIdentity.isFile() || currentIdentity.isSymbolicLink()) return false;
    if (currentIdentity.dev !== observedIdentity.dev || currentIdentity.ino !== observedIdentity.ino) return false;
    fs.unlinkSync(filePath);
    return true;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

export function isBuiltInProfile(data: ProfilesData, name: string): boolean {
    return Object.hasOwn(data.built_in_profiles, name);
}

export function getAllProfileNames(data: ProfilesData): string[] {
    return [
        ...Object.keys(data.built_in_profiles),
        ...Object.keys(data.user_profiles)
    ];
}

export function getProfileEntry(data: ProfilesData, name: string): ProfileEntry | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return data.built_in_profiles[name];
    if (Object.hasOwn(data.user_profiles, name)) return data.user_profiles[name];
    return null;
}
