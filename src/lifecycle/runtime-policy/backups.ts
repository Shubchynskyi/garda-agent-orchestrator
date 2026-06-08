import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import {
    createRollbackSnapshot,
    ensureWithinRoot,
    getRollbackRecordsPath,
    getTimestamp,
    readRollbackRecords,
    validateTargetRoot,
    writeRollbackRecords
} from '../common';
import { getUpdateRollbackItems } from '../update/update';
import { processCleanupCandidates } from '../cleanup/cleanup-removal';
import type { CleanupItem } from '../cleanup/cleanup-types';

export const DEFAULT_BACKUP_KEEP_LATEST = 10;

const BACKUP_METADATA_FILE_NAME = 'backup-metadata.json';
const BACKUP_ID_PATTERN = /^(update|scheduled)-(\d{8}-\d{6})(?:-(\d{3}))?$/i;
const BACKUP_TIMESTAMP_PATTERN = /^\d{8}-\d{6}(?:-\d{3})?$/;

export type BackupReason = 'update' | 'scheduled';
export type BackupHealthStatus = 'AVAILABLE' | 'MISSING_RECORDS' | 'INVALID_RECORDS';

export interface BackupMetadata {
    schemaVersion: 1;
    reason: BackupReason;
    createdAt: string;
    source: 'backup-backend';
}

export interface BackupSummary {
    id: string;
    reason: BackupReason;
    createdAt: string;
    snapshotPath: string;
    relativeSnapshotPath: string;
    restoreSnapshotPath: string;
    rollbackRecordsPath: string;
    sizeBytes: number;
    recordCount: number;
    health: BackupHealthStatus;
    healthMessage: string | null;
}

export interface CreateBackupSnapshotOptions {
    targetRoot: string;
    bundleRoot: string;
    reason: BackupReason;
    initAnswersPath?: string;
    timestamp?: string;
}

export interface BackupRetentionOptions {
    targetRoot: string;
    bundleRoot?: string;
    keepLatest?: number;
    dryRun?: boolean;
}

export interface BackupRetentionResult {
    targetRoot: string;
    keepLatest: number;
    dryRun: boolean;
    candidates: CleanupItem[];
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
    result: 'SUCCESS' | 'ERRORS';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRuntimeRoot(targetRoot: string): string {
    return path.join(targetRoot, resolveBundleName(), 'runtime');
}

export function getBackupSnapshotsRoot(targetRoot: string): string {
    return path.join(getRuntimeRoot(targetRoot), 'update-rollbacks');
}

function getBackupMetadataPath(snapshotPath: string): string {
    return path.join(snapshotPath, BACKUP_METADATA_FILE_NAME);
}

function toRelativeTargetPath(targetRoot: string, absolutePath: string): string {
    return path.relative(targetRoot, absolutePath).replace(/\\/g, '/');
}

function calculatePathSizeBytes(targetPath: string): number {
    try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            return stat.size;
        }
    } catch {
        return 0;
    }

    let total = 0;
    const stack = [targetPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            try {
                total += fs.statSync(fullPath).size;
            } catch {
                // Ignore unreadable files while reporting best-effort inventory size.
            }
        }
    }
    return total;
}

function normalizeBackupTimestamp(timestamp: string): string {
    const normalized = String(timestamp || '').trim();
    if (!BACKUP_TIMESTAMP_PATTERN.test(normalized)) {
        throw new Error(`Backup timestamp must match YYYYMMDD-HHMMSS[-mmm]: ${timestamp}`);
    }
    return normalized;
}

function parseCreatedAtFromId(id: string): string | null {
    const match = BACKUP_ID_PATTERN.exec(id);
    if (!match) {
        return null;
    }
    const [, , baseTimestamp, millis = '000'] = match;
    const compact = `${baseTimestamp}-${millis}`;
    const dateMatch = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(compact);
    if (!dateMatch) {
        return null;
    }
    const [, year, month, day, hour, minute, second, ms] = dateMatch;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(ms)
    ).toISOString();
}

function inferReasonFromId(id: string): BackupReason | null {
    const match = BACKUP_ID_PATTERN.exec(id);
    if (!match) {
        return null;
    }
    return match[1].toLowerCase() === 'scheduled' ? 'scheduled' : 'update';
}

function readBackupMetadata(snapshotPath: string): BackupMetadata | null {
    const metadataPath = getBackupMetadataPath(snapshotPath);
    if (!fs.existsSync(metadataPath)) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const parsedObject = isJsonObject(parsed) ? parsed : null;
        const reason = parsedObject?.reason === 'scheduled' ? 'scheduled'
            : parsedObject?.reason === 'update' ? 'update'
                : null;
        const createdAt = typeof parsedObject?.createdAt === 'string' && parsedObject.createdAt.trim()
            ? parsedObject.createdAt.trim()
            : null;
        if (!reason || !createdAt) {
            return null;
        }
        return {
            schemaVersion: 1,
            reason,
            createdAt,
            source: 'backup-backend'
        };
    } catch {
        return null;
    }
}

function writeBackupMetadata(snapshotPath: string, metadata: BackupMetadata): string {
    const metadataPath = getBackupMetadataPath(snapshotPath);
    fs.mkdirSync(snapshotPath, { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return metadataPath;
}

function getBackupDirectoryEntries(targetRoot: string): string[] {
    const snapshotsRoot = getBackupSnapshotsRoot(targetRoot);
    if (!fs.existsSync(snapshotsRoot)) {
        return [];
    }
    return fs.readdirSync(snapshotsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}

function buildBackupSummary(targetRoot: string, snapshotPath: string): BackupSummary {
    const id = path.basename(snapshotPath);
    const metadata = readBackupMetadata(snapshotPath);
    const reason = metadata?.reason ?? inferReasonFromId(id) ?? 'update';
    const createdAt = metadata?.createdAt ?? parseCreatedAtFromId(id) ?? fs.statSync(snapshotPath).mtime.toISOString();
    const rollbackRecordsPath = getRollbackRecordsPath(snapshotPath);

    let recordCount = 0;
    let health: BackupHealthStatus = 'AVAILABLE';
    let healthMessage: string | null = null;
    try {
        recordCount = readRollbackRecords(snapshotPath).length;
    } catch (error: unknown) {
        healthMessage = error instanceof Error ? error.message : String(error);
        health = fs.existsSync(rollbackRecordsPath) ? 'INVALID_RECORDS' : 'MISSING_RECORDS';
    }

    return {
        id,
        reason,
        createdAt,
        snapshotPath,
        relativeSnapshotPath: toRelativeTargetPath(targetRoot, snapshotPath),
        restoreSnapshotPath: snapshotPath,
        rollbackRecordsPath,
        sizeBytes: calculatePathSizeBytes(snapshotPath),
        recordCount,
        health,
        healthMessage
    };
}

function compareBackupNewestFirst(left: BackupSummary, right: BackupSummary): number {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
    }
    return right.id.localeCompare(left.id);
}

export function listBackups(targetRoot: string): BackupSummary[] {
    const normalizedTarget = path.resolve(targetRoot);
    const snapshotsRoot = getBackupSnapshotsRoot(normalizedTarget);
    return getBackupDirectoryEntries(normalizedTarget)
        .map((entryName) => buildBackupSummary(normalizedTarget, path.join(snapshotsRoot, entryName)))
        .sort(compareBackupNewestFirst);
}

export function resolveBackupRestoreSnapshotPath(targetRoot: string, backupIdOrPath: string): string {
    const normalizedTarget = path.resolve(targetRoot);
    const value = String(backupIdOrPath || '').trim();
    if (!value) {
        throw new Error('Backup restore target is required.');
    }

    const byId = listBackups(normalizedTarget).find((backup) => backup.id === value);
    const candidate = byId
        ? byId.snapshotPath
        : path.isAbsolute(value)
            ? value
            : path.resolve(normalizedTarget, value);
    const resolved = ensureWithinRoot(normalizedTarget, candidate, 'Backup restore snapshot path');
    const summary = listBackups(normalizedTarget).find((backup) => path.resolve(backup.snapshotPath) === resolved);
    if (!summary) {
        throw new Error(`Backup restore target was not found in backup inventory: ${backupIdOrPath}`);
    }
    if (summary.health !== 'AVAILABLE') {
        throw new Error(`Backup '${summary.id}' is not restorable: ${summary.healthMessage || summary.health}`);
    }
    return resolved;
}

export function createBackupSnapshot(options: CreateBackupSnapshotOptions): BackupSummary {
    const {
        targetRoot,
        bundleRoot,
        reason,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        timestamp = getTimestamp()
    } = options;
    if (reason !== 'update' && reason !== 'scheduled') {
        throw new Error(`Unsupported backup reason: ${reason}`);
    }

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const normalizedTimestamp = normalizeBackupTimestamp(timestamp);
    const snapshotPath = path.join(getBackupSnapshotsRoot(normalizedTarget), `${reason}-${normalizedTimestamp}`);
    const initAnswersResolvedPath = path.isAbsolute(initAnswersPath)
        ? initAnswersPath
        : path.resolve(normalizedTarget, initAnswersPath);
    ensureWithinRoot(normalizedTarget, initAnswersResolvedPath, 'Init answers path');

    const rollbackItems = getUpdateRollbackItems(normalizedTarget, initAnswersResolvedPath);
    const records = createRollbackSnapshot(normalizedTarget, snapshotPath, rollbackItems);
    writeRollbackRecords(snapshotPath, records);
    writeBackupMetadata(snapshotPath, {
        schemaVersion: 1,
        reason,
        createdAt: parseCreatedAtFromId(path.basename(snapshotPath)) ?? new Date().toISOString(),
        source: 'backup-backend'
    });

    return buildBackupSummary(normalizedTarget, snapshotPath);
}

export function pruneBackups(options: BackupRetentionOptions): BackupRetentionResult {
    const {
        targetRoot,
        bundleRoot = path.join(targetRoot, resolveBundleName()),
        keepLatest = DEFAULT_BACKUP_KEEP_LATEST,
        dryRun = false
    } = options;
    if (!Number.isInteger(keepLatest) || keepLatest < 0) {
        throw new Error(`Backup retention keepLatest must be a non-negative integer: ${keepLatest}`);
    }

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const runtimeRoot = getRuntimeRoot(normalizedTarget);
    const candidates = listBackups(normalizedTarget)
        .slice(keepLatest)
        .map((backup): CleanupItem => ({
            path: backup.snapshotPath,
            category: 'backups',
            reason: 'count',
            sizeBytes: backup.sizeBytes
        }));
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun, runtimeRoot);
    return {
        targetRoot: normalizedTarget,
        keepLatest,
        dryRun,
        candidates,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'ERRORS' : 'SUCCESS'
    };
}
