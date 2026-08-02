import { runGitBinary } from './git-helpers';
import { normalizePath } from './orchestrator-paths';

const STAGED_INDEX_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STAGED_INDEX_TIMEOUT_MS = 30_000;

export type StagedBlobFingerprints = ReadonlyMap<string, string>;

export function readStagedBlobFingerprints(
    repoRoot: string,
    relativePaths: readonly string[]
): Map<string, string> {
    const wantedPaths = new Set(
        relativePaths.map((relativePath) => normalizePath(relativePath)).filter(Boolean)
    );
    const fingerprints = new Map<string, string>();
    if (wantedPaths.size === 0) {
        return fingerprints;
    }

    let output: Buffer;
    try {
        output = runGitBinary(repoRoot, ['ls-files', '--stage', '-z'], {
            allowFailure: true,
            maxBuffer: STAGED_INDEX_MAX_BUFFER_BYTES,
            timeoutMs: STAGED_INDEX_TIMEOUT_MS
        });
    } catch {
        return fingerprints;
    }

    for (const record of output.toString('utf8').split('\0')) {
        if (!record) {
            continue;
        }
        const tabIndex = record.indexOf('\t');
        if (tabIndex < 0) {
            continue;
        }
        const relativePath = normalizePath(record.slice(tabIndex + 1));
        if (!wantedPaths.has(relativePath) || fingerprints.has(relativePath)) {
            continue;
        }
        const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+$/u.exec(record.slice(0, tabIndex));
        if (!match?.[1] || !match[2]) {
            continue;
        }
        fingerprints.set(relativePath, `staged:${match[1]}:${match[2].toLowerCase()}`);
    }

    return fingerprints;
}
