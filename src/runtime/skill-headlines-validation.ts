import {
    SKILLS_HEADLINES_VERSION,
    type SkillsHeadlinePackEntry,
    type SkillsHeadlineSkillEntry
} from './skill-headlines-types';

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValidSkillsHeadlineSkillEntry(value: unknown): value is SkillsHeadlineSkillEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.directory === 'string'
        && typeof record.name === 'string'
        && typeof record.summary === 'string'
        && (record.pack === null || typeof record.pack === 'string')
        && (record.source === 'baseline' || record.source === 'installed_optional' || record.source === 'custom_live')
        && typeof record.implemented === 'boolean'
        && (record.review_binding === 'review_bound' || record.review_binding === 'general_purpose')
        && isStringArray(record.aliases)
        && isStringArray(record.task_signals)
        && isStringArray(record.changed_path_signals)
        && isStringArray(record.tags);
}

function isValidSkillsHeadlinePackEntry(value: unknown): value is SkillsHeadlinePackEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.label === 'string'
        && typeof record.description === 'string'
        && typeof record.installed === 'boolean'
        && typeof record.implemented === 'boolean'
        && typeof record.collides_with_baseline === 'boolean'
        && isStringArray(record.ready_skill_ids)
        && isStringArray(record.placeholder_skill_ids)
        && isStringArray(record.recommended_for)
        && isStringArray(record.tags);
}

export function isValidSkillsHeadlinesPayload(value: Record<string, unknown>): boolean {
    if (Number(value.version || 0) !== SKILLS_HEADLINES_VERSION) {
        return false;
    }
    if (
        !isStringArray(value.installed_pack_ids)
        || !isStringArray(value.baseline_skill_ids)
        || !isStringArray(value.installed_optional_skill_ids)
        || !isStringArray(value.custom_skill_ids)
        || !Array.isArray(value.skills)
        || !Array.isArray(value.optional_packs)
    ) {
        return false;
    }
    return value.skills.every((skill) => isValidSkillsHeadlineSkillEntry(skill))
        && value.optional_packs.every((pack) => isValidSkillsHeadlinePackEntry(pack));
}
