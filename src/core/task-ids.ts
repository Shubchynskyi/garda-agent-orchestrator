export const TASK_ID_MAX_LENGTH = 128;
export const TASK_ID_ALLOWED_PATTERN = /^[A-Za-z0-9._-]+$/u;
export const TASK_ID_CHARACTER_PATTERN = /^[A-Za-z0-9._-]$/u;

export function assertCanonicalTaskId(value: unknown): string {
    if (!value || !String(value).trim()) {
        throw new Error('TaskId must not be empty.');
    }
    const taskId = String(value).trim();
    if (taskId.length > TASK_ID_MAX_LENGTH) {
        throw new Error('TaskId must be 128 characters or fewer.');
    }
    if (!TASK_ID_ALLOWED_PATTERN.test(taskId)) {
        throw new Error(`TaskId '${taskId}' contains invalid characters. Allowed pattern: ^[A-Za-z0-9._-]+$`);
    }
    return taskId;
}

export function isCanonicalTaskId(value: unknown): boolean {
    try {
        assertCanonicalTaskId(value);
        return true;
    } catch {
        return false;
    }
}

export function isTaskIdReferenceBoundary(value: string | undefined): boolean {
    return value === undefined || !TASK_ID_CHARACTER_PATTERN.test(value);
}

export function escapeRegExpLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildExactTaskIdReferencePattern(taskId: string): RegExp {
    return new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExpLiteral(taskId)}(?=$|[^A-Za-z0-9._-])`, 'u');
}

export function parseTaskIdJsonlFileName(fileName: string): string | null {
    if (!fileName.endsWith('.jsonl') || fileName === 'all-tasks.jsonl') {
        return null;
    }
    const taskId = fileName.slice(0, -'.jsonl'.length).trim();
    return isCanonicalTaskId(taskId) ? taskId : null;
}

export function parseKnownReviewArtifactTaskId(
    fileName: string,
    knownSuffixes: readonly string[]
): string | null {
    for (const suffix of knownSuffixes) {
        if (fileName.endsWith(suffix)) {
            const taskId = fileName.slice(0, fileName.length - suffix.length);
            return isCanonicalTaskId(taskId) ? taskId : null;
        }
        const gzSuffix = `${suffix}.gz`;
        if (fileName.endsWith(gzSuffix)) {
            const taskId = fileName.slice(0, fileName.length - gzSuffix.length);
            return isCanonicalTaskId(taskId) ? taskId : null;
        }
    }
    return null;
}

export function parseConventionalReviewArtifactTaskId(fileName: string): string | null {
    const match = /^(T-\d+(?:-\d+)*)-.+$/iu.exec(fileName);
    if (!match) {
        return null;
    }
    const taskId = match[1];
    return isCanonicalTaskId(taskId) ? taskId : null;
}

export function taskIdsEqualCaseInsensitive(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export function parseActiveReviewArtifactTaskId(
    fileName: string,
    activeTaskIds: ReadonlySet<string>
): string | null {
    const taskIds = Array.from(activeTaskIds)
        .filter((taskId) => isCanonicalTaskId(taskId))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
    const normalizedFileName = fileName.toLowerCase();
    for (const taskId of taskIds) {
        if (normalizedFileName.startsWith(`${taskId.toLowerCase()}-`)) {
            return taskId;
        }
    }
    return null;
}
