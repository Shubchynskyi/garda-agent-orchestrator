import { isCanonicalTaskId } from './task-ids';

export type ParentDerivedTaskIdKind = 'child' | 'followup';

function normalizeExistingTaskIds(existingTaskIds: Iterable<string>): Set<string> {
    return new Set([...existingTaskIds].map((taskId) => String(taskId || '').trim().toLowerCase()).filter(Boolean));
}

function buildCandidate(parentTaskId: string, kind: ParentDerivedTaskIdKind, index: number): string {
    return kind === 'followup'
        ? `${parentTaskId}-F${index}`
        : `${parentTaskId}-${index}`;
}

export function allocateParentDerivedTaskIds(params: {
    parentTaskId: string;
    existingTaskIds: Iterable<string>;
    kind: ParentDerivedTaskIdKind;
    count: number;
}): string[] {
    const parentTaskId = String(params.parentTaskId || '').trim();
    if (!isCanonicalTaskId(parentTaskId)) {
        throw new Error(`Cannot allocate parent-derived task ids from invalid parent task id '${parentTaskId}'.`);
    }
    const count = Math.max(0, Math.floor(params.count));
    const existing = normalizeExistingTaskIds(params.existingTaskIds);
    const allocated: string[] = [];
    for (let index = 1; allocated.length < count; index += 1) {
        const candidate = buildCandidate(parentTaskId, params.kind, index);
        if (!isCanonicalTaskId(candidate)) {
            throw new Error(`Generated task id '${candidate}' does not satisfy the canonical task-id contract.`);
        }
        const normalizedCandidate = candidate.toLowerCase();
        if (existing.has(normalizedCandidate)) {
            continue;
        }
        existing.add(normalizedCandidate);
        allocated.push(candidate);
    }
    return allocated;
}

export function allocateNextParentDerivedTaskId(params: {
    parentTaskId: string;
    existingTaskIds: Iterable<string>;
    kind: ParentDerivedTaskIdKind;
}): string {
    return allocateParentDerivedTaskIds({
        parentTaskId: params.parentTaskId,
        existingTaskIds: params.existingTaskIds,
        kind: params.kind,
        count: 1
    })[0];
}
