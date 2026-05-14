import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { KNOWN_SUFFIXES, invalidateIndex as invalidateReviewsIndex } from '../gate-runtime/reviews-index';
import {
    parseActiveReviewArtifactTaskId,
    parseConventionalReviewArtifactTaskId,
    parseKnownReviewArtifactTaskId
} from '../core/task-ids';
import type {
    ReviewArtifactRetentionMode,
    ReviewArtifactStoragePolicy,
    StoragePolicyResult
} from './cleanup-types';

const DEFAULT_STORAGE_POLICY: ReviewArtifactStoragePolicy = {
    retentionMode: 'full',
    compressAfterDays: 7,
    compressionFormat: 'gzip',
    preserveGateReceipts: true,
    gateReceiptSuffixes: [
        '-task-mode.json',
        '-preflight.json',
        '-compile-gate.json',
        '-completion-gate.json',
        '-rule-pack.json',
        '-handshake.json'
    ]
};

function validateRetentionMode(value: unknown): ReviewArtifactRetentionMode {
    if (value === 'none' || value === 'summary' || value === 'full') return value;
    return 'full';
}

export function loadStoragePolicy(bundleRoot: string): ReviewArtifactStoragePolicy {
    const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
    if (!fs.existsSync(configPath)) {
        return { ...DEFAULT_STORAGE_POLICY };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return {
            retentionMode: validateRetentionMode(raw.retention_mode),
            compressAfterDays: typeof raw.compress_after_days === 'number' && raw.compress_after_days >= 0
                ? raw.compress_after_days
                : DEFAULT_STORAGE_POLICY.compressAfterDays,
            compressionFormat: raw.compression_format === 'gzip'
                ? 'gzip'
                : DEFAULT_STORAGE_POLICY.compressionFormat,
            preserveGateReceipts: typeof raw.preserve_gate_receipts === 'boolean'
                ? raw.preserve_gate_receipts
                : DEFAULT_STORAGE_POLICY.preserveGateReceipts,
            gateReceiptSuffixes: Array.isArray(raw.gate_receipt_suffixes)
                ? raw.gate_receipt_suffixes.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
                : [...DEFAULT_STORAGE_POLICY.gateReceiptSuffixes]
        };
    } catch {
        return { ...DEFAULT_STORAGE_POLICY };
    }
}

export function isGateReceipt(fileName: string, suffixes: string[]): boolean {
    return suffixes.some((suffix) => fileName.endsWith(suffix));
}

export function compressFileGzip(filePath: string): string {
    const content = fs.readFileSync(filePath);
    const compressed = zlib.gzipSync(content);
    const compressedPath = `${filePath}.gz`;
    const tmpPath = `${compressedPath}.tmp`;
    fs.writeFileSync(tmpPath, compressed);
    fs.renameSync(tmpPath, compressedPath);
    fs.unlinkSync(filePath);
    return compressedPath;
}

export function applyStoragePolicy(
    reviewsDir: string,
    policy: ReviewArtifactStoragePolicy,
    activeTaskIds: Set<string>
): StoragePolicyResult {
    const result: StoragePolicyResult = {
        compressed: [],
        removed: [],
        preserved: [],
        retentionMode: policy.retentionMode
    };

    if (!fs.existsSync(reviewsDir)) return result;

    let entries: string[];
    try {
        entries = fs.readdirSync(reviewsDir).sort();
    } catch {
        return result;
    }

    const now = Date.now();
    const compressCutoffMs = policy.compressAfterDays > 0
        ? policy.compressAfterDays * 24 * 60 * 60 * 1000
        : 0;

    for (const entry of entries) {
        if (!entry.endsWith('.json') && !entry.endsWith('.md') && !entry.endsWith('.diff')) continue;

        const filePath = path.join(reviewsDir, entry);
        const taskId = parseActiveReviewArtifactTaskId(entry, activeTaskIds)
            ?? parseKnownReviewArtifactTaskId(entry, KNOWN_SUFFIXES)
            ?? parseConventionalReviewArtifactTaskId(entry);
        if (!taskId) continue;
        if (activeTaskIds.has(taskId)) {
            result.preserved.push(entry);
            continue;
        }

        const receipt = isGateReceipt(entry, policy.gateReceiptSuffixes);

        if (policy.retentionMode === 'none') {
            if (policy.preserveGateReceipts && receipt) {
                result.preserved.push(entry);
            } else {
                try {
                    fs.unlinkSync(filePath);
                    result.removed.push(entry);
                } catch {
                    result.preserved.push(entry);
                }
            }
            continue;
        }

        if (policy.retentionMode === 'summary') {
            if (receipt) {
                result.preserved.push(entry);
            } else {
                try {
                    fs.unlinkSync(filePath);
                    result.removed.push(entry);
                } catch {
                    result.preserved.push(entry);
                }
            }
            continue;
        }

        if (compressCutoffMs > 0) {
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > compressCutoffMs) {
                    compressFileGzip(filePath);
                    result.compressed.push(entry);
                    continue;
                }
            } catch {
                // Skip unreadable files.
            }
        }

        result.preserved.push(entry);
    }

    if (result.removed.length > 0 || result.compressed.length > 0) {
        try {
            invalidateReviewsIndex(reviewsDir);
        } catch {
            // Best-effort index invalidation.
        }
    }

    return result;
}
