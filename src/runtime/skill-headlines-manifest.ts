import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathExists } from '../core/filesystem';
import {
    BASELINE_SKILL_DIRECTORIES,
    normalizeNonNegativeInteger,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeStringArray,
    readBaselineSkillManifest,
    readSkillManifest,
    type BaselineSkillManifestDefinition,
    type SkillManifestDefinition,
    type SkillPackManifestDefinition
} from './skill-manifest';
import { getLiveSkillsRoot } from './skill-headlines-sources';
import {
    OPTIONAL_SKILL_PLACEHOLDER_PATTERN,
    REVIEW_BOUND_SPECIAL_CASE_IDS,
    type SkillsHeadlinePackEntry,
    type SkillsHeadlineSkillEntry,
    type SkillsHeadlinesSourceFileSnapshot
} from './skill-headlines-types';

export function isPlaceholderOptionalSkill(summary: unknown, skillRoot: string): boolean {
    if (OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(String(summary || ''))) {
        return true;
    }
    const skillPath = path.join(skillRoot, 'SKILL.md');
    if (!pathExists(skillPath)) {
        return false;
    }
    try {
        return OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(fs.readFileSync(skillPath, 'utf8'));
    } catch {
        return false;
    }
}

export function parsePackManifestSnapshot(snapshot: SkillsHeadlinesSourceFileSnapshot): SkillPackManifestDefinition {
    const packRoot = path.dirname(snapshot.filePath);
    const fallbackPackId = path.basename(packRoot);
    return {
        id: normalizeRequiredString(snapshot.parsed.id || fallbackPackId, `pack.json id (${fallbackPackId})`),
        label: normalizeRequiredString(snapshot.parsed.label || fallbackPackId, `pack.json label (${fallbackPackId})`),
        description: normalizeRequiredString(snapshot.parsed.description, `pack.json description (${fallbackPackId})`),
        tags: normalizeStringArray(snapshot.parsed.tags),
        recommendedFor: normalizeStringArray(snapshot.parsed.recommended_for),
        packRoot
    };
}

export function parseSkillManifestSnapshot(
    snapshot: SkillsHeadlinesSourceFileSnapshot,
    fallbackPackId: string
): SkillManifestDefinition {
    const skillRoot = path.dirname(snapshot.filePath);
    const fallbackSkillId = path.basename(skillRoot);
    const skillId = normalizeRequiredString(snapshot.parsed.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`);
    const packId = normalizeRequiredString(snapshot.parsed.pack || fallbackPackId, `skill.json pack (${skillId})`);
    return {
        id: skillId,
        name: normalizeRequiredString(snapshot.parsed.name || skillId, `skill.json name (${skillId})`),
        pack: packId,
        summary: normalizeRequiredString(snapshot.parsed.summary, `skill.json summary (${skillId})`),
        tags: normalizeStringArray(snapshot.parsed.tags),
        aliases: normalizeStringArray(snapshot.parsed.aliases),
        stackSignals: normalizeStringArray(snapshot.parsed.stack_signals),
        taskSignals: normalizeStringArray(snapshot.parsed.task_signals),
        changedPathSignals: normalizeStringArray(snapshot.parsed.changed_path_signals),
        references: normalizeStringArray(snapshot.parsed.references),
        costHint: normalizeRequiredString(snapshot.parsed.cost_hint || 'low', `skill.json cost_hint (${skillId})`),
        priority: normalizeNonNegativeInteger(snapshot.parsed.priority, 50),
        autoload: normalizeRequiredString(snapshot.parsed.autoload || 'never', `skill.json autoload (${skillId})`),
        deprecated: snapshot.parsed.deprecated === true,
        replacedBy: normalizeOptionalString(snapshot.parsed.replaced_by),
        implemented: !isPlaceholderOptionalSkill(snapshot.parsed.summary, skillRoot),
        skillRoot
    };
}

export function parseBaselineSkillManifestSnapshot(snapshot: SkillsHeadlinesSourceFileSnapshot): BaselineSkillManifestDefinition {
    const skillRoot = path.dirname(snapshot.filePath);
    const fallbackSkillId = path.basename(skillRoot);
    return {
        id: normalizeRequiredString(snapshot.parsed.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`),
        name: normalizeRequiredString(snapshot.parsed.name || fallbackSkillId, `skill.json name (${fallbackSkillId})`),
        summary: normalizeRequiredString(snapshot.parsed.summary, `skill.json summary (${fallbackSkillId})`),
        tags: normalizeStringArray(snapshot.parsed.tags),
        aliases: normalizeStringArray(snapshot.parsed.aliases),
        references: normalizeStringArray(snapshot.parsed.references),
        costHint: normalizeRequiredString(snapshot.parsed.cost_hint || 'low', `skill.json cost_hint (${fallbackSkillId})`),
        priority: normalizeNonNegativeInteger(snapshot.parsed.priority, 50),
        autoload: normalizeRequiredString(snapshot.parsed.autoload || 'never', `skill.json autoload (${fallbackSkillId})`),
        skillRoot
    };
}

export function getReviewBinding(skill: {
    id: string;
    tags: readonly string[];
}): 'review_bound' | 'general_purpose' {
    const normalizedSkillId = String(skill.id || '').trim().toLowerCase();
    const normalizedTags = skill.tags.map((tag) => String(tag || '').trim().toLowerCase());

    if (normalizedSkillId.endsWith('-review') || REVIEW_BOUND_SPECIAL_CASE_IDS.has(normalizedSkillId)) {
        return 'review_bound';
    }

    if (normalizedTags.includes('review') || normalizedTags.includes('reviews')) {
        return 'review_bound';
    }

    return 'general_purpose';
}

export function toOptionalPackEntry(
    pack: {
        id: string;
        label: string;
        description: string;
        implemented?: boolean;
        collidesWithBaseline?: boolean;
        readySkillDirectories: readonly string[];
        placeholderSkillDirectories: readonly string[];
        recommendedFor: readonly string[];
        tags: readonly string[];
    },
    installedPackIds: readonly string[]
): SkillsHeadlinePackEntry {
    return {
        id: pack.id,
        label: pack.label,
        description: pack.description,
        installed: installedPackIds.includes(pack.id),
        implemented: pack.implemented !== false,
        collides_with_baseline: pack.collidesWithBaseline === true,
        ready_skill_ids: [...pack.readySkillDirectories].sort(),
        placeholder_skill_ids: [...pack.placeholderSkillDirectories].sort(),
        recommended_for: [...pack.recommendedFor].sort(),
        tags: [...pack.tags].sort()
    };
}

export function tryBuildBaselineSkillEntry(bundleRoot: string, skillDirectory: string): SkillsHeadlineSkillEntry | null {
    const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillDirectory);
    if (!pathExists(skillRoot)) {
        return null;
    }

    try {
        const manifest = readBaselineSkillManifest(skillRoot);
        return {
            id: manifest.id,
            directory: skillDirectory,
            name: manifest.name,
            summary: manifest.summary,
            pack: null,
            source: 'baseline',
            implemented: true,
            review_binding: getReviewBinding({
                id: manifest.id,
                tags: manifest.tags
            }),
            aliases: [...manifest.aliases].sort(),
            task_signals: [],
            changed_path_signals: [],
            tags: [...manifest.tags].sort()
        };
    } catch {
        return null;
    }
}

export function tryBuildLiveSkillEntry(
    bundleRoot: string,
    skillDirectory: string,
    source: 'installed_optional' | 'custom_live',
    fallbackPackId: string
): SkillsHeadlineSkillEntry | null {
    const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillDirectory);
    if (!pathExists(skillRoot)) {
        return null;
    }

    try {
        const manifest = readSkillManifest(skillRoot, fallbackPackId);
        return {
            id: manifest.id,
            directory: skillDirectory,
            name: manifest.name,
            summary: manifest.summary,
            pack: manifest.pack || null,
            source,
            implemented: manifest.implemented !== false,
            review_binding: getReviewBinding({
                id: manifest.id,
                tags: manifest.tags
            }),
            aliases: [...manifest.aliases].sort(),
            task_signals: [...manifest.taskSignals].sort(),
            changed_path_signals: [...manifest.changedPathSignals].sort(),
            tags: [...manifest.tags].sort()
        };
    } catch {
        return null;
    }
}

export function isBaselineSkillDirectory(skillId: string): boolean {
    return BASELINE_SKILL_DIRECTORIES.includes(skillId);
}
