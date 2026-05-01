import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathExists } from '../../core/filesystem';
import { formatJson } from '../../core/json';

import {
    type SkillsHeadlinesPayload,
    type SkillsHeadlinePackEntry,
    type SkillsHeadlineSkillEntry
} from '../skill-headlines';

export const OPTIONAL_SKILL_SELECTION_POLICY_MODES = Object.freeze([
    'off',
    'advisory',
    'required',
    'strict'
] as const);

export type OptionalSkillSelectionPolicyMode = typeof OPTIONAL_SKILL_SELECTION_POLICY_MODES[number];

export const OPTIONAL_SKILL_AS_IS_REASONS = Object.freeze([
    'policy_off',
    'no_relevant_installed_skill',
    'task_too_small',
    'generic_context_sufficient',
    'low_confidence_match'
] as const);

export type OptionalSkillSelectionAsIsReason = typeof OPTIONAL_SKILL_AS_IS_REASONS[number];

export interface OptionalSkillSelectionPolicyConfig {
    version: number;
    mode: OptionalSkillSelectionPolicyMode;
}

export type OptionalSkillSelectionDecision =
    | 'selected_installed_skills'
    | 'recommended_missing_packs'
    | 'as_is';

export interface MatchGroups {
    task_signals: string[];
    changed_path_signals: string[];
}

export interface OptionalSkillSelectionEntry {
    id: string;
    pack: string | null;
    source: 'installed_optional' | 'custom_live';
    allowed_skill_path: string;
    reason_codes: Array<'task_signals' | 'changed_path_signals'>;
    matches: MatchGroups;
}

export interface OptionalSkillSelectionRecommendedPack {
    id: string;
    label: string;
    ready_skill_ids: string[];
    reason_codes: Array<'task_signals' | 'changed_path_signals'>;
    matches: MatchGroups;
}

export interface OptionalSkillSelectionArtifact {
    schema_version: 1;
    event_source: 'optional-skill-selection';
    task_id: string;
    timestamp_utc: string;
    policy_mode: OptionalSkillSelectionPolicyMode;
    decision: OptionalSkillSelectionDecision;
    selected_installed_skills: OptionalSkillSelectionEntry[];
    recommended_missing_packs: OptionalSkillSelectionRecommendedPack[];
    as_is_reason: OptionalSkillSelectionAsIsReason | null;
    task_text_present: boolean;
    task_text_sha256: string | null;
    changed_paths: string[];
    preflight_path: string | null;
    preflight_sha256: string | null;
    headlines_path: string;
    headlines_sha256: string | null;
    visible_summary_line: string;
}

export interface OptionalSkillSelectionArtifactData {
    artifactPath: string;
    payload: OptionalSkillSelectionArtifact;
    loadedHeadlinesCache?: {
        headlinesPath: string;
        headlinesSha256: string | null;
        materializationNeeded?: boolean;
        skills: SkillsHeadlineSkillEntry[];
        optional_packs: SkillsHeadlinePackEntry[];
        payload?: SkillsHeadlinesPayload | null;
    } | null;
}

export interface BuildOptionalSkillSelectionOptions {
    taskText?: string | null;
    changedPaths?: string[] | null;
    preflightPath?: string | null;
    preflightSha256?: string | null;
    loadedHeadlinesCache?: {
        headlinesPath: string;
        headlinesSha256: string | null;
        materializationNeeded?: boolean;
        skills: SkillsHeadlineSkillEntry[];
        optional_packs: SkillsHeadlinePackEntry[];
        payload?: SkillsHeadlinesPayload | null;
    } | null;
}

export interface WriteOptionalSkillSelectionOptions extends BuildOptionalSkillSelectionOptions {
    preparedArtifact?: OptionalSkillSelectionArtifactData | null;
}

export interface SkillCandidateScore {
    entry: OptionalSkillSelectionEntry;
    score: number;
    strong_match: boolean;
}

export interface PackCandidateScore {
    entry: OptionalSkillSelectionRecommendedPack;
    score: number;
}

export interface LoadedSkillsHeadlinesData {
    headlinesPath: string;
    headlinesSha256: string | null;
    materializationNeeded: boolean;
    skills: SkillsHeadlineSkillEntry[];
    optional_packs: SkillsHeadlinePackEntry[];
    payload: SkillsHeadlinesPayload;
}

export interface LoadSkillsHeadlinesOptions {
    preferPersistedSurface?: boolean;
}

export interface OptionalSkillSelectionReferenceLoadEvidence {
    skillId: string | null;
    referencePath: string;
    resolvedReferencePath: string;
    triggerReason: string | null;
    timestampUtc: string | null;
}

export interface OptionalSkillSelectionActivationEvidence {
    skillId: string | null;
    triggerReason: string | null;
    timestampUtc: string | null;
}

export interface OptionalSkillSelectionTimelineEvidence {
    timelinePath: string;
    exists: boolean;
    invalidJson: boolean;
    eventTypes: Set<string>;
    latestTaskModeEnteredTimestampUtc: string | null;
    latestCycleBoundaryTimestampUtc: string | null;
    optionalSkillActivations: OptionalSkillSelectionActivationEvidence[];
    optionalSkillReferenceLoads: OptionalSkillSelectionReferenceLoadEvidence[];
}

export const DEFAULT_POLICY_CONFIG: OptionalSkillSelectionPolicyConfig = Object.freeze({
    version: 1,
    mode: 'advisory'
});

export const MAX_SELECTED_SKILLS = 2;
export const MAX_RECOMMENDED_PACKS = 3;
export const SKILL_SELECTION_THRESHOLD = 60;
export const PACK_RECOMMENDATION_THRESHOLD = 60;

export const COMMON_SIGNAL_STOP_WORDS = new Set([
    'and', 'for', 'the', 'with', 'into', 'from', 'like', 'work', 'task',
    'flow', 'mode', 'this', 'that', 'across', 'safety', 'delivery',
    'production', 'general', 'purpose'
]);

export function normalizeText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function uniqueSorted(items: string[]): string[] {
    return [...new Set(items.filter(Boolean))].sort();
}

export function computeOptionalSkillTaskTextSha256(taskText: string): string | null {
    const normalizedTaskText = String(taskText || '').trim();
    if (!normalizedTaskText) {
        return null;
    }
    return createHash('sha256').update(normalizedTaskText, 'utf8').digest('hex');
}

export function computeFileSha256(filePath: string | null | undefined): string | null {
    if (!filePath || !pathExists(filePath)) {
        return null;
    }
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

export function computeSkillsHeadlinesPayloadSha256(payload: SkillsHeadlinesPayload): string {
    return createHash('sha256').update(formatJson(payload), 'utf8').digest('hex');
}

export function selectLatestTimestamp(
    currentTimestampUtc: string | null,
    nextTimestampUtc: string | null
): string | null {
    const currentTimestampMs = toTimestampMs(currentTimestampUtc);
    const nextTimestampMs = toTimestampMs(nextTimestampUtc);
    if (nextTimestampMs === null) {
        return currentTimestampUtc;
    }
    if (currentTimestampMs === null || nextTimestampMs >= currentTimestampMs) {
        return nextTimestampUtc;
    }
    return currentTimestampUtc;
}

export function resolvePortableRepoPath(bundleRoot: string, portablePath: string): string {
    const normalizedPath = String(portablePath || '').trim();
    if (!normalizedPath) {
        return '';
    }
    if (path.isAbsolute(normalizedPath)) {
        return path.resolve(normalizedPath);
    }
    return path.resolve(path.dirname(path.resolve(bundleRoot)), normalizedPath);
}

export function toPortableBundlePath(bundleRoot: string, absolutePath: string): string {
    const orchestratorRoot = path.resolve(bundleRoot);
    const relative = path.relative(path.dirname(orchestratorRoot), absolutePath).replace(/\\/g, '/');
    if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)) {
        return relative;
    }
    return absolutePath.replace(/\\/g, '/');
}

export function toTimestampMs(value: string | null | undefined): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}
