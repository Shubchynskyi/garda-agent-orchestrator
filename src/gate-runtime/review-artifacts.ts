import * as fs from 'node:fs';
import * as path from 'node:path';

import { acquireFilesystemLock, releaseFilesystemLock } from './task-events';
import { upsertEntry } from './reviews-index';

const DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS = 25;
const DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS = 30 * 1000;

export interface ReviewArtifactLockOptions {
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
}

export interface ReviewArtifactLockTelemetry {
    retries: number;
    elapsedMs: number;
}

export interface ReviewArtifactWriteResult {
    artifact_path: string;
    lock_path: string;
    telemetry: ReviewArtifactLockTelemetry;
}

export function getReviewArtifactLockPath(artifactPath: string): string {
    return `${artifactPath}.lock`;
}

function createTempArtifactPath(artifactPath: string): string {
    const directoryPath = path.dirname(artifactPath);
    const fileName = path.basename(artifactPath);
    const randomSuffix = Math.random().toString(16).slice(2, 10);
    return path.join(directoryPath, `.${fileName}.tmp-${process.pid}-${Date.now()}-${randomSuffix}`);
}

function closeFileDescriptor(fileDescriptor: number | undefined): void {
    if (fileDescriptor === undefined) {
        return;
    }
    fs.closeSync(fileDescriptor);
}

export function writeArtifactFileAtomically(filePath: string, content: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = createTempArtifactPath(filePath);
    let fileDescriptor: number | undefined;
    try {
        fileDescriptor = fs.openSync(tempPath, 'wx');
        fs.writeFileSync(fileDescriptor, content, 'utf8');
        fs.fsyncSync(fileDescriptor);
        closeFileDescriptor(fileDescriptor);
        fileDescriptor = undefined;
        fs.renameSync(tempPath, filePath);
        return filePath;
    } catch (error: unknown) {
        try {
            closeFileDescriptor(fileDescriptor);
        } catch {
            // Best-effort cleanup only.
        }
        try {
            fs.rmSync(tempPath, { force: true });
        } catch {
            // Best-effort cleanup only.
        }
        throw error;
    }
}

export function withReviewArtifactLock<T>(
    artifactPath: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): { result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry } {
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    try {
        return {
            result: callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}

export function writeReviewArtifactText(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    const { lock_path, telemetry } = withReviewArtifactLock(artifactPath, () => {
        writeArtifactFileAtomically(artifactPath, content);
    }, options);
    try {
        upsertEntry(path.dirname(artifactPath), path.basename(artifactPath));
    } catch {
        // Index update is best-effort; artifact write succeeded
    }
    return {
        artifact_path: artifactPath,
        lock_path,
        telemetry
    };
}

export function writeReviewArtifactJson(
    artifactPath: string,
    payload: unknown,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    return writeReviewArtifactText(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, options);
}
