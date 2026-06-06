import type * as fs from 'node:fs';

export interface SkillsHeadlineSkillEntry {
    id: string;
    directory: string;
    name: string;
    summary: string;
    pack: string | null;
    source: 'baseline' | 'installed_optional' | 'custom_live';
    implemented: boolean;
    review_binding: 'review_bound' | 'general_purpose';
    aliases: string[];
    task_signals: string[];
    changed_path_signals: string[];
    tags: string[];
}

export interface SkillsHeadlinePackEntry {
    id: string;
    label: string;
    description: string;
    installed: boolean;
    implemented: boolean;
    collides_with_baseline: boolean;
    ready_skill_ids: string[];
    placeholder_skill_ids: string[];
    recommended_for: string[];
    tags: string[];
}

export interface SkillsHeadlinesPayload {
    version: number;
    source_state_sha256?: string;
    source_state_hint_sha256?: string;
    installed_pack_ids: string[];
    baseline_skill_ids: string[];
    installed_optional_skill_ids: string[];
    custom_skill_ids: string[];
    skills: SkillsHeadlineSkillEntry[];
    optional_packs: SkillsHeadlinePackEntry[];
}

export interface SkillsHeadlinesData {
    headlinesPath: string;
    sha256: string | null;
    payload: SkillsHeadlinesPayload;
}

export interface SkillsHeadlinesSourceFileSnapshot {
    filePath: string;
    relativePath: string;
    stats: fs.Stats;
    text: string;
    parsed: Record<string, unknown>;
}

export interface CurrentSkillsHeadlinesState {
    headlinesPath: string;
    snapshots: SkillsHeadlinesSourceFileSnapshot[];
    installedPackIds: string[];
    installedOptionalSkillIds: string[];
    customSkillIds: string[];
    skills: SkillsHeadlineSkillEntry[];
    optionalPacks: SkillsHeadlinePackEntry[];
}

export const SKILLS_HEADLINES_VERSION = 2;

export const REVIEW_BOUND_SPECIAL_CASE_IDS = new Set<string>([
    'devops-k8s',
    'testing-strategy'
]);

export const OPTIONAL_SKILL_PLACEHOLDER_PATTERN = /TODO:\s*fill this optional skill\.?/i;
