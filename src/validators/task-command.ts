import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildActiveProfileGuidance, buildTaskStartNavigatorPrompt } from '../core/onboarding-contract';
import { assertCanonicalTaskId } from '../core/task-ids';
import { getProfileEntry, loadProfilesData, type ProfilesData } from '../policy/profile-resolver';
import { readCanonicalActiveQueueRows } from '../reports/report-data/task-queue';

export interface ProfileTaskHint {
    activeProfile: string | null;
    activeProfileDepth: number;
}

export interface ExecutableTaskQueueResolution {
    taskId: string | null;
    queuePresent: boolean;
}

const DEFAULT_TASK_ID = 'T-001';
const DEFAULT_TASK_DEPTH = 2;
const EXECUTABLE_TASK_STATUSES = new Set(['TODO', 'IN_PROGRESS', 'IN_REVIEW']);
const NO_EXECUTABLE_TASKS_COMMAND = 'No executable tasks found in TASK.md Active Queue; add or reopen a task before starting task execution.';

function resolveProfilesPath(bundlePath: string): string {
    return path.join(bundlePath, 'live', 'config', 'profiles.json');
}

function normalizeTaskDepth(rawDepth: unknown): number {
    const depth = Number.parseInt(String(rawDepth), 10);
    if (Number.isFinite(depth) && depth >= 1 && depth <= 3) return depth;
    return DEFAULT_TASK_DEPTH;
}

function readProfileData(bundlePath: string): ProfilesData | null {
    const profilesPath = resolveProfilesPath(bundlePath);
    if (!fs.existsSync(profilesPath)) return null;
    try {
        return loadProfilesData(profilesPath);
    } catch {
        return null;
    }
}

export function readActiveProfileHint(bundlePath: string): ProfileTaskHint {
    const profilesData = readProfileData(bundlePath);
    if (!profilesData) {
        return {
            activeProfile: null,
            activeProfileDepth: DEFAULT_TASK_DEPTH
        };
    }

    const activeProfile = typeof profilesData.active_profile === 'string'
        ? profilesData.active_profile.trim()
        : '';
    if (!activeProfile) {
        return {
            activeProfile: null,
            activeProfileDepth: DEFAULT_TASK_DEPTH
        };
    }

    const activeEntry = getProfileEntry(profilesData, activeProfile);
    if (!activeEntry) {
        return {
            activeProfile: null,
            activeProfileDepth: DEFAULT_TASK_DEPTH
        };
    }

    return {
        activeProfile,
        activeProfileDepth: normalizeTaskDepth(activeEntry.depth)
    };
}

function buildExecuteTaskCommand(taskId: string): string {
    return buildTaskStartNavigatorPrompt(taskId);
}

export function resolveExecutableTaskQueue(targetRoot: string): ExecutableTaskQueueResolution {
    const activeQueue = readCanonicalActiveQueueRows(targetRoot);
    if (activeQueue.unavailable.some((entry) => entry.reason.includes('not found'))) {
        return { taskId: null, queuePresent: false };
    }

    for (const row of activeQueue.rows) {
        let taskId: string;
        try {
            taskId = assertCanonicalTaskId(row.task_id);
        } catch {
            continue;
        }

        const statusToken = row.status_token;
        if (statusToken && EXECUTABLE_TASK_STATUSES.has(statusToken)) {
            return { taskId, queuePresent: true };
        }
    }

    return { taskId: null, queuePresent: true };
}

export function resolveExecutableTaskIdFromQueue(targetRoot: string): string | null {
    return resolveExecutableTaskQueue(targetRoot).taskId;
}

export function resolveProfileAwareExecuteTaskRecommendation(
    targetRoot: string,
    bundlePath: string
): string {
    const resolution = resolveExecutableTaskQueue(targetRoot);
    if (resolution.taskId) {
        return buildProfileAwareExecuteTaskNextCommand(bundlePath, resolution.taskId);
    }
    if (resolution.queuePresent) {
        readActiveProfileHint(bundlePath);
        return NO_EXECUTABLE_TASKS_COMMAND;
    }
    return buildProfileAwareExecuteTaskNextCommand(bundlePath);
}

export function buildProfileAwareExecuteTaskNextCommand(
    bundlePath: string,
    taskId = DEFAULT_TASK_ID
): string {
    readActiveProfileHint(bundlePath);
    return buildExecuteTaskCommand(taskId);
}

export function buildProfileAwareNextLine(bundlePath: string, taskId = DEFAULT_TASK_ID, cliCommand = 'node bin/garda.js'): string {
    const hint = readActiveProfileHint(bundlePath);
    const command = buildExecuteTaskCommand(taskId);
    if (!hint.activeProfile) {
        return `Next: ${command}`;
    }

    return `Next: ${command} ${buildActiveProfileGuidance(hint.activeProfile, cliCommand)}`;
}

export function buildProfileAwareQueueNextLine(
    targetRoot: string,
    bundlePath: string,
    cliCommand = 'node bin/garda.js'
): string {
    const resolution = resolveExecutableTaskQueue(targetRoot);
    if (!resolution.taskId && resolution.queuePresent) {
        readActiveProfileHint(bundlePath);
        return `Next: ${NO_EXECUTABLE_TASKS_COMMAND}`;
    }
    return buildProfileAwareNextLine(bundlePath, resolution.taskId || DEFAULT_TASK_ID, cliCommand);
}
