import * as fs from 'node:fs';
import {
    isCanonicalTaskId,
    parseStructuredTaskArtifactTaskId,
    taskIdsEqualCaseInsensitive
} from '../../core/task-ids';

export function readTaskIdFromJsonReviewArtifact(filePath: string): string | null {
    if (!filePath.endsWith('.json')) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        const taskId = parsed.task_id;
        return isCanonicalTaskId(taskId) ? String(taskId).trim() : null;
    } catch {
        return null;
    }
}

export function resolveStructuredOrJsonReviewArtifactTaskId(filePath: string, fileName: string): string | null {
    const structuredTaskId = parseStructuredTaskArtifactTaskId(fileName);
    const jsonTaskId = readTaskIdFromJsonReviewArtifact(filePath);
    if (jsonTaskId && structuredTaskId) {
        return taskIdsEqualCaseInsensitive(jsonTaskId, structuredTaskId) ? structuredTaskId : null;
    }
    return jsonTaskId ?? structuredTaskId;
}
