import {
    normalizePath
} from '../shared/helpers';

const TASK_OWNED_METADATA_REFRESH_FILES = new Set([
    'TASK.md'
]);

export function isTaskOwnedMetadataRefreshFile(changedFile: string): boolean {
    return TASK_OWNED_METADATA_REFRESH_FILES.has(normalizePath(changedFile));
}

export function mergeTaskOwnedMetadataRefreshFiles(
    baseFiles: readonly string[],
    candidateFiles: readonly string[] | undefined
): string[] {
    const merged = new Set(baseFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    for (const candidateFile of candidateFiles || []) {
        const normalizedFile = normalizePath(candidateFile);
        if (normalizedFile && isTaskOwnedMetadataRefreshFile(normalizedFile)) {
            merged.add(normalizedFile);
        }
    }
    return [...merged].sort();
}
