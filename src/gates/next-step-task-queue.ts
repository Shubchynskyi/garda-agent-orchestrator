import {
    isTaskQueueBlockedStatus,
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus
} from '../core/active-task-state';
import {
    buildExactTaskIdReferencePattern,
    isCanonicalTaskId,
    isTaskIdReferenceBoundary
} from '../core/task-ids';

export interface TaskQueueEntry {
    taskId: string;
    status: string | null;
    area: string | null;
    title: string | null;
    profile: string | null;
    notes: string | null;
}

export interface DecomposedChildRoute {
    taskId: string;
    status: string | null;
    chain: string[];
}

export interface DecomposedParentCompletionState {
    hasLinkedChildren: boolean;
    complete: boolean;
    unfinishedRoute: DecomposedChildRoute | null;
    completedDecomposedTaskIds: string[];
    missingChildTaskIds: string[];
}

interface ChildTaskIdMention {
    taskId: string;
    index: number;
}

export interface StrictDecompositionSplitRoutingState {
    ready: boolean;
    linkedChildTaskIds: string[];
    missingLinkedChildTaskIds: string[];
    missingChildTaskIds: string[];
    nonParentDerivedChildTaskIds: string[];
    unexpectedLinkedChildTaskIds: string[];
    nonStrictChildTaskIds: string[];
    childRoute: DecomposedChildRoute | null;
}

const TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN = /\b(?:paused\s+for\s+split|split\s+into|continue\s+via\s+child\s+tasks)\b/i;
const TASK_QUEUE_CHILD_LINK_MARKER_PATTERN =
    /\b(?:split\s+into|continue\s+via|execute|created?|linked)\b[^.;\n|]*\b(?:child(?:ren)?|leaf)\s+tasks?\b|\b(?:child(?:ren)?|leaf)\s+tasks?\s*:/igu;
export const SPLIT_REQUIRED_STATUS = 'SPLIT_REQUIRED';

function isLegacySplitParentTask(entry: TaskQueueEntry | null): boolean {
    if (!entry) {
        return false;
    }
    if (!isTaskQueueBlockedStatus(entry.status)) {
        return false;
    }
    return TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN.test(String(entry.notes || ''));
}

export function isDecomposedParentTask(entry: TaskQueueEntry | null): boolean {
    return Boolean(entry && (isTaskQueueDecomposedStatus(entry.status) || isLegacySplitParentTask(entry)));
}

function appendTaskMentionIfMissing(taskMentions: ChildTaskIdMention[], taskId: string, index: number): void {
    if (!taskMentions.some((mention) => mention.taskId === taskId)) {
        taskMentions.push({ taskId, index });
    }
}

function isExplicitChildListMentionPosition(text: string, index: number): boolean {
    const introPattern = /\b(?:child(?:ren)?|leaf)\s+tasks?\b\s*:*/igu;
    let introMatch: RegExpExecArray | null;
    let introEnd: number | null = null;
    while ((introMatch = introPattern.exec(text)) !== null) {
        if (introMatch.index > index) {
            break;
        }
        introEnd = introMatch.index + introMatch[0].length;
    }
    if (introEnd == null) {
        return false;
    }
    const listPrefix = text.slice(introEnd, index)
        .replace(/`[A-Za-z0-9._-]+`/gu, ' ')
        .replace(/(^|[^A-Za-z0-9._-])([Tt]-\d+)(?=$|[^A-Za-z0-9._-])/gu, '$1 ');
    return /^[\s,:()[\]\-–—]*(?:(?:and|or|through|to)[\s,:()[\]\-–—]*)*$/iu.test(listPrefix);
}

function extractChildTaskMentions(notes: string | null, knownTaskIds: Iterable<string>): ChildTaskIdMention[] {
    const text = String(notes || '');
    const taskMentions: ChildTaskIdMention[] = [];
    const rangePattern = /\b([Tt]-)(\d+)\b[\s`*_]*(?:through|to|-|–|—)[\s`*_]*\b([Tt]-)(\d+)\b/gu;
    let rangeMatch: RegExpExecArray | null;
    while ((rangeMatch = rangePattern.exec(text)) !== null) {
        const startPrefix = rangeMatch[1];
        const startRaw = rangeMatch[2];
        const endPrefix = rangeMatch[3];
        const endRaw = rangeMatch[4];
        if (startPrefix !== endPrefix) {
            continue;
        }
        const start = Number(startRaw);
        const end = Number(endRaw);
        if (!Number.isInteger(start) || !Number.isInteger(end) || Math.abs(end - start) > 100) {
            continue;
        }
        const step = start <= end ? 1 : -1;
        const width = startRaw.length === endRaw.length ? startRaw.length : 0;
        let offset = 0;
        for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
            const valueText = width > 0 ? String(Math.abs(value)).padStart(width, '0') : String(Math.abs(value));
            const signedValueText = value < 0 ? `-${valueText}` : valueText;
            appendTaskMentionIfMissing(taskMentions, `${startPrefix}${signedValueText}`, rangeMatch.index + offset);
            offset += 1;
        }
    }

    const backtickedTaskIdPattern = /`([^`]+)`/gu;
    let backtickedTaskIdMatch: RegExpExecArray | null;
    while ((backtickedTaskIdMatch = backtickedTaskIdPattern.exec(text)) !== null) {
        const taskId = String(backtickedTaskIdMatch[1] || '').trim();
        if (isCanonicalTaskId(taskId)
            && isExplicitChildListMentionPosition(text, backtickedTaskIdMatch.index)) {
            appendTaskMentionIfMissing(taskMentions, taskId, backtickedTaskIdMatch.index + 1);
        }
    }

    const conventionalTaskIdPattern = /(^|[^A-Za-z0-9._-])([Tt]-\d+)(?=$|[^A-Za-z0-9._-])/gu;
    let conventionalTaskIdMatch: RegExpExecArray | null;
    while ((conventionalTaskIdMatch = conventionalTaskIdPattern.exec(text)) !== null) {
        const taskId = conventionalTaskIdMatch[2];
        const mentionIndex = conventionalTaskIdMatch.index + conventionalTaskIdMatch[1].length;
        appendTaskMentionIfMissing(taskMentions, taskId, mentionIndex);
    }

    for (const taskId of knownTaskIds) {
        const taskIdPattern = buildExactTaskIdReferencePattern(taskId);
        const taskIdMatch = taskIdPattern.exec(text);
        if (taskIdMatch) {
            const mentionIndex = taskIdMatch.index + taskIdMatch[1].length;
            const isConventionalTaskId = /^[Tt]-\d+$/u.test(taskId);
            if (!isConventionalTaskId && !isExplicitChildListMentionPosition(text, mentionIndex)) {
                continue;
            }
            appendTaskMentionIfMissing(taskMentions, taskId, taskIdMatch.index + taskIdMatch[1].length);
        }
    }
    return taskMentions
        .sort((left, right) => left.index - right.index);
}

function isTaskIdCharacter(value: string): boolean {
    return !isTaskIdReferenceBoundary(value);
}

function isExplicitChildContinuationBoundary(text: string, index: number): boolean {
    return /^(?:,\s*)?then\s+continue\b/iu.test(text.slice(index));
}

function findExplicitChildSegmentEnd(text: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (isExplicitChildContinuationBoundary(text, index)) {
            return index;
        }
        const current = text[index];
        if (current === ';' || current === '\n' || current === '|') {
            return index;
        }
        if (current === '.') {
            const previous = text[index - 1] || '';
            const next = text[index + 1] || '';
            if (!(isTaskIdCharacter(previous) && isTaskIdCharacter(next))) {
                return index;
            }
        }
    }
    return text.length;
}

export function extractExplicitLinkedChildTaskIds(notes: string | null, knownTaskIds: Iterable<string>): string[] {
    const text = String(notes || '');
    const childTaskIds: ChildTaskIdMention[] = [];
    const knownTaskIdList = [...knownTaskIds];
    let markerMatch: RegExpExecArray | null;
    TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.lastIndex = 0;
    while ((markerMatch = TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.exec(text)) !== null) {
        const absoluteSegmentEnd = findExplicitChildSegmentEnd(text, markerMatch.index);
        const segment = text.slice(markerMatch.index, absoluteSegmentEnd);
        for (const childMention of extractChildTaskMentions(segment, knownTaskIdList)) {
            appendTaskMentionIfMissing(childTaskIds, childMention.taskId, markerMatch.index + childMention.index);
        }
    }
    return childTaskIds
        .sort((left, right) => left.index - right.index)
        .map((mention) => mention.taskId);
}

export function resolveNextUnfinishedChildRoute(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (notes: string | null, knownTaskIds: Iterable<string>) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedChildRoute | null {
    if (visited.has(parentTaskId)) {
        return null;
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys())
        .filter((childTaskId) => childTaskId !== parentTaskId);

    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            continue;
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isDecomposedParentTask(childEntry)) {
            const nestedRoute = resolveNextUnfinishedChildRoute(taskEntries, childTaskId, visited, childTaskIdExtractor);
            if (nestedRoute) {
                return {
                    ...nestedRoute,
                    chain: [childTaskId, ...nestedRoute.chain]
                };
            }
            continue;
        }
        return {
            taskId: childTaskId,
            status: childEntry.status,
            chain: [childTaskId]
        };
    }
    return null;
}

export function resolveDecomposedParentCompletionState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (notes: string | null, knownTaskIds: Iterable<string>) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedParentCompletionState {
    if (visited.has(parentTaskId)) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys())
        .filter((childTaskId) => childTaskId !== parentTaskId);

    if (childTaskIds.length === 0) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }

    const completedDecomposedTaskIds: string[] = [];
    const missingChildTaskIds: string[] = [];
    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            missingChildTaskIds.push(childTaskId);
            continue;
        }
        const childLinkedTaskIds = childTaskIdExtractor(childEntry.notes || null, taskEntries.keys())
            .filter((nestedChildTaskId) => nestedChildTaskId !== childTaskId);
        if (childLinkedTaskIds.length > 0 && (
            isTaskQueueDoneStatus(childEntry.status)
            || isTaskQueueDecomposedStatus(childEntry.status)
        )) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            if (nestedState.complete) {
                completedDecomposedTaskIds.push(...nestedState.completedDecomposedTaskIds, childTaskId);
                continue;
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isTaskQueueDecomposedStatus(childEntry.status)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            if (nestedState.complete) {
                completedDecomposedTaskIds.push(...nestedState.completedDecomposedTaskIds, childTaskId);
                continue;
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        if (isLegacySplitParentTask(childEntry)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: {
                taskId: childTaskId,
                status: childEntry.status,
                chain: [childTaskId]
            },
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    if (missingChildTaskIds.length > 0) {
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    return {
        hasLinkedChildren: true,
        complete: true,
        unfinishedRoute: null,
        completedDecomposedTaskIds,
        missingChildTaskIds: []
    };
}

export function hasLinkedChildTasks(taskEntries: Map<string, TaskQueueEntry>, parentTaskId: string): boolean {
    const parentEntry = taskEntries.get(parentTaskId);
    return extractExplicitLinkedChildTaskIds(parentEntry?.notes || null, taskEntries.keys())
        .some((childTaskId) => childTaskId !== parentTaskId && taskEntries.has(childTaskId));
}

function isParentDerivedChildTaskId(parentTaskId: string, childTaskId: string): boolean {
    const normalizedParent = parentTaskId.toLowerCase();
    const normalizedChild = childTaskId.toLowerCase();
    return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}-`);
}

export function resolveStrictDecompositionSplitRoutingState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    proposedChildTaskIds: string[]
): StrictDecompositionSplitRoutingState {
    const parentEntry = taskEntries.get(parentTaskId);
    const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(parentEntry?.notes || null, taskEntries.keys())
        .filter((childTaskId) => childTaskId !== parentTaskId);
    const linkedChildTaskIdSet = new Set(linkedChildTaskIds);
    const proposedChildTaskIdSet = new Set(proposedChildTaskIds);
    const nonParentDerivedChildTaskIds = [...new Set([...proposedChildTaskIds, ...linkedChildTaskIds])]
        .filter((childTaskId) => !isParentDerivedChildTaskId(parentTaskId, childTaskId));
    const unexpectedLinkedChildTaskIds = linkedChildTaskIds
        .filter((childTaskId) => isParentDerivedChildTaskId(parentTaskId, childTaskId) && !proposedChildTaskIdSet.has(childTaskId));
    const missingLinkedChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => !linkedChildTaskIdSet.has(childTaskId));
    const missingChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => !taskEntries.has(childTaskId));
    const nonStrictChildTaskIds = proposedChildTaskIds
        .filter((childTaskId) => {
            const childEntry = taskEntries.get(childTaskId);
            return childEntry && String(childEntry.profile || '').trim().toLowerCase() !== 'strict';
        });

    const ready = proposedChildTaskIds.length > 0
        && missingLinkedChildTaskIds.length === 0
        && missingChildTaskIds.length === 0
        && nonParentDerivedChildTaskIds.length === 0
        && unexpectedLinkedChildTaskIds.length === 0
        && nonStrictChildTaskIds.length === 0;

    return {
        ready,
        linkedChildTaskIds,
        missingLinkedChildTaskIds,
        missingChildTaskIds,
        nonParentDerivedChildTaskIds,
        unexpectedLinkedChildTaskIds,
        nonStrictChildTaskIds,
        childRoute: ready
            ? resolveNextUnfinishedChildRoute(taskEntries, parentTaskId, new Set<string>(), extractExplicitLinkedChildTaskIds)
            : null
    };
}

export function formatStrictDecompositionSplitRoutingViolations(state: StrictDecompositionSplitRoutingState): string {
    const violations: string[] = [];
    if (state.missingLinkedChildTaskIds.length > 0) {
        violations.push(`missing linked proposed child tasks: ${state.missingLinkedChildTaskIds.join(', ')}`);
    }
    if (state.missingChildTaskIds.length > 0) {
        violations.push(`missing TASK.md child rows: ${state.missingChildTaskIds.join(', ')}`);
    }
    if (state.nonParentDerivedChildTaskIds.length > 0) {
        violations.push(`non-parent-derived child task ids: ${state.nonParentDerivedChildTaskIds.join(', ')}`);
    }
    if (state.unexpectedLinkedChildTaskIds.length > 0) {
        violations.push(`linked child tasks not declared in the decision artifact: ${state.unexpectedLinkedChildTaskIds.join(', ')}`);
    }
    if (state.nonStrictChildTaskIds.length > 0) {
        violations.push(`child tasks without strict profile: ${state.nonStrictChildTaskIds.join(', ')}`);
    }
    if (violations.length === 0) {
        return 'child routing is not ready';
    }
    return violations.join('; ');
}
