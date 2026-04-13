import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProfileEntry, loadProfilesData, type ProfilesData } from '../policy/profile-resolver';

export interface ProfileTaskHint {
    activeProfile: string | null;
    activeProfileDepth: number;
}

const DEFAULT_TASK_ID = 'T-001';
const DEFAULT_TASK_DEPTH = 2;

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

function buildExecuteTaskCommand(taskId: string, hint: ProfileTaskHint): string {
    if (!hint.activeProfile) return `Execute task ${taskId}`;
    return `Execute task ${taskId} depth=${hint.activeProfileDepth} (profile: ${hint.activeProfile})`;
}

export function buildProfileAwareExecuteTaskNextCommand(bundlePath: string, taskId = DEFAULT_TASK_ID): string {
    return buildExecuteTaskCommand(taskId, readActiveProfileHint(bundlePath));
}

export function buildProfileAwareNextLine(bundlePath: string, taskId = DEFAULT_TASK_ID): string {
    return `Next: ${buildProfileAwareExecuteTaskNextCommand(bundlePath, taskId)}`;
}
