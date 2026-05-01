import * as path from 'node:path';
import { pathExists } from '../../core/filesystem';
import {
    type SkillsHeadlineSkillEntry,
    type SkillsHeadlinePackEntry,
    buildSkillsHeadlines,
    getSkillsHeadlinesConfigPath
} from '../skill-headlines';
import {
    containsAtWordBoundary,
    textMatchesFuzzyVariant
} from '../skill-resolution';

import {
    type BuildOptionalSkillSelectionOptions,
    type OptionalSkillSelectionArtifactData,
    type OptionalSkillSelectionDecision,
    type OptionalSkillSelectionAsIsReason,
    type OptionalSkillSelectionEntry,
    type OptionalSkillSelectionRecommendedPack,
    type MatchGroups,
    type SkillCandidateScore,
    type PackCandidateScore,
    SKILL_SELECTION_THRESHOLD,
    PACK_RECOMMENDATION_THRESHOLD,
    COMMON_SIGNAL_STOP_WORDS,
    MAX_SELECTED_SKILLS,
    MAX_RECOMMENDED_PACKS,
    normalizeText,
    uniqueSorted,
    computeFileSha256,
    computeOptionalSkillTaskTextSha256,
    toPortableBundlePath
} from './types';
import { loadSkillsHeadlines } from './headlines-cache';
import { readOptionalSkillSelectionPolicyConfig } from './config';
import { getOptionalSkillSelectionArtifactPath } from './artifact-store';

export function buildEmptyMatches(): MatchGroups {
    return {
        task_signals: [],
        changed_path_signals: []
    };
}

export function addMatch(target: string[], signal: string): void {
    const normalized = String(signal || '').trim();
    if (!normalized || target.includes(normalized)) {
        return;
    }
    target.push(normalized);
}

export function textContainsSignal(text: string, signal: string): boolean {
    const normalizedSignal = normalizeText(signal).replace(/\*/g, '');
    if (!normalizedSignal) {
        return false;
    }
    return containsAtWordBoundary(text, normalizedSignal) || textMatchesFuzzyVariant(text, normalizedSignal);
}

export function pathContainsSignal(paths: readonly string[], signal: string): boolean {
    const normalizedSignal = normalizeText(signal);
    if (!normalizedSignal) {
        return false;
    }
    return paths.some((candidate) => textContainsSignal(candidate, normalizedSignal));
}

export function splitTextSignals(value: string): string[] {
    const normalized = normalizeText(value);
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/[^a-z0-9.#/+_-]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length >= 4 && !COMMON_SIGNAL_STOP_WORDS.has(entry));
}

export function isDocumentationLikePath(value: string): boolean {
    const normalized = normalizeText(value);
    if (!normalized) {
        return false;
    }
    return normalized.endsWith('.md')
        || normalized.endsWith('.mdx')
        || normalized.endsWith('.txt')
        || normalized.startsWith('docs/')
        || normalized.includes('/docs/')
        || normalized.includes('/adr/')
        || normalized.includes('/decisions/')
        || normalized.includes('/runbooks/')
        || normalized.includes('/postmortem')
        || normalized.includes('/migration-guide')
        || normalized.includes('changelog');
}

export function skillLooksDocumentationOrProcess(skill: SkillsHeadlineSkillEntry): boolean {
    if (normalizeText(skill.pack) === 'docs-process') {
        return true;
    }
    const normalizedTags = uniqueSorted(
        (Array.isArray(skill.tags) ? skill.tags : [])
            .map((entry) => normalizeText(entry))
            .filter(Boolean)
    );
    return normalizedTags.some((tag) => (
        tag === 'docs'
        || tag === 'documentation'
        || tag === 'changelog'
        || tag === 'adr'
        || tag === 'runbook'
        || tag === 'postmortem'
        || tag === 'migration-guide'
    ));
}

export function hasNonDocumentationChangedPaths(paths: readonly string[]): boolean {
    return paths.some((entry) => !isDocumentationLikePath(entry));
}

export function collectPrimarySignals(skill: SkillsHeadlineSkillEntry): string[] {
    return uniqueSorted([
        skill.id,
        skill.name,
        ...(Array.isArray(skill.aliases) ? skill.aliases : []),
        ...(Array.isArray(skill.task_signals) ? skill.task_signals : []),
        ...(Array.isArray(skill.changed_path_signals) ? skill.changed_path_signals : [])
    ].map((entry) => normalizeText(entry)).filter(Boolean));
}

export function collectSecondarySignals(skill: SkillsHeadlineSkillEntry): string[] {
    const summarySignals = splitTextSignals(skill.summary || '');
    return uniqueSorted([
        ...(Array.isArray(skill.tags) ? skill.tags : []),
        ...summarySignals
    ].map((entry) => normalizeText(entry)).filter(Boolean));
}

export function scoreSignalBuckets(
    taskTextLower: string,
    changedPathsLower: string[],
    primarySignals: readonly string[],
    secondarySignals: readonly string[]
): { score: number; matches: MatchGroups; strong_match: boolean } {
    const matches = buildEmptyMatches();
    let score = 0;
    let strongMatch = false;

    for (const signal of primarySignals) {
        if (textContainsSignal(taskTextLower, signal)) {
            addMatch(matches.task_signals, signal);
            score += 60;
            strongMatch = true;
        }
        if (pathContainsSignal(changedPathsLower, signal)) {
            addMatch(matches.changed_path_signals, signal);
            score += 55;
            strongMatch = true;
        }
    }

    for (const signal of secondarySignals) {
        if (textContainsSignal(taskTextLower, signal)) {
            addMatch(matches.task_signals, signal);
            score += 25;
        }
        if (pathContainsSignal(changedPathsLower, signal)) {
            addMatch(matches.changed_path_signals, signal);
            score += 20;
        }
    }

    if (matches.task_signals.length > 0 && matches.changed_path_signals.length > 0) {
        score += 20;
    }

    return {
        score,
        matches,
        strong_match: strongMatch
    };
}

export function getReasonCodes(matches: MatchGroups): Array<'task_signals' | 'changed_path_signals'> {
    const reasons: Array<'task_signals' | 'changed_path_signals'> = [];
    if (matches.task_signals.length > 0) {
        reasons.push('task_signals');
    }
    if (matches.changed_path_signals.length > 0) {
        reasons.push('changed_path_signals');
    }
    return reasons;
}

export function summarizeReasonCodes(reasonCodes: readonly string[]): string {
    const hasTaskSignals = reasonCodes.includes('task_signals');
    const hasPathSignals = reasonCodes.includes('changed_path_signals');
    if (hasTaskSignals && hasPathSignals) {
        return 'task_text+paths';
    }
    if (hasTaskSignals) {
        return 'task_text';
    }
    if (hasPathSignals) {
        return 'paths';
    }
    return 'none';
}

export function selectInstalledSkills(
    bundleRoot: string,
    taskTextLower: string,
    changedPathsLower: string[],
    skills: SkillsHeadlineSkillEntry[]
): SkillCandidateScore[] {
    const candidates: SkillCandidateScore[] = [];
    for (const skill of skills) {
        if (skill.review_binding !== 'general_purpose') {
            continue;
        }
        if (skill.source !== 'installed_optional' && skill.source !== 'custom_live') {
            continue;
        }
        if (skill.implemented === false) {
            continue;
        }

        const primarySignals = collectPrimarySignals(skill);
        const secondarySignals = collectSecondarySignals(skill);
        const scored = scoreSignalBuckets(taskTextLower, changedPathsLower, primarySignals, secondarySignals);
        if (scored.score <= 0) {
            continue;
        }
        const mixedCodeAndDocsScope = skillLooksDocumentationOrProcess(skill) && hasNonDocumentationChangedPaths(changedPathsLower);

        const skillDirectory = String(skill.directory || skill.id || '').trim();
        const skillPath = path.join(bundleRoot, 'live', 'skills', skillDirectory, 'SKILL.md');
        if (!pathExists(skillPath)) {
            continue;
        }
        candidates.push({
            score: scored.score,
            strong_match: mixedCodeAndDocsScope ? false : scored.strong_match,
            entry: {
                id: skill.id,
                pack: skill.pack || null,
                source: skill.source,
                allowed_skill_path: toPortableBundlePath(bundleRoot, skillPath),
                reason_codes: getReasonCodes(scored.matches),
                matches: scored.matches
            }
        });
    }

    return candidates.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        return left.entry.id.localeCompare(right.entry.id);
    });
}

export function selectRecommendedPacks(
    taskTextLower: string,
    changedPathsLower: string[],
    packs: SkillsHeadlinePackEntry[],
    availableSkillIds: Set<string>
): PackCandidateScore[] {
    const candidates: PackCandidateScore[] = [];
    for (const pack of packs) {
        if (pack.installed || pack.implemented === false) {
            continue;
        }
        if (pack.ready_skill_ids.every((skillId) => availableSkillIds.has(skillId))) {
            continue;
        }

        const primarySignals = uniqueSorted([
            pack.id,
            pack.label,
            ...pack.ready_skill_ids
        ].map((entry) => normalizeText(entry)).filter(Boolean));
        const secondarySignals = uniqueSorted([
            ...pack.tags,
            ...pack.recommended_for.flatMap((entry) => splitTextSignals(String(entry)))
        ].map((entry) => normalizeText(entry)).filter(Boolean));
        const scored = scoreSignalBuckets(taskTextLower, changedPathsLower, primarySignals, secondarySignals);
        if (scored.score <= 0) {
            continue;
        }

        candidates.push({
            score: scored.score,
            entry: {
                id: pack.id,
                label: pack.label,
                ready_skill_ids: [...pack.ready_skill_ids],
                reason_codes: getReasonCodes(scored.matches),
                matches: scored.matches
            }
        });
    }

    return candidates.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        return left.entry.id.localeCompare(right.entry.id);
    });
}

export function resolveAsIsReason(
    taskText: string,
    changedPaths: string[],
    topSkillScore: number,
    recommendedMissingPacks: OptionalSkillSelectionRecommendedPack[]
): OptionalSkillSelectionAsIsReason {
    if (!taskText.trim() && changedPaths.length === 0) {
        return 'task_too_small';
    }
    if (taskText.trim().split(/\s+/).length <= 5 && changedPaths.length <= 1) {
        return 'task_too_small';
    }
    if (recommendedMissingPacks.length > 0) {
        return 'no_relevant_installed_skill';
    }
    if (topSkillScore > 0 && topSkillScore < SKILL_SELECTION_THRESHOLD) {
        return 'low_confidence_match';
    }
    return 'generic_context_sufficient';
}

export function buildVisibleSummaryLine(payload: {
    decision: OptionalSkillSelectionDecision;
    selectedInstalledSkills: OptionalSkillSelectionEntry[];
    recommendedMissingPacks: OptionalSkillSelectionRecommendedPack[];
    asIsReason: OptionalSkillSelectionAsIsReason | null;
}): string {
    if (payload.selectedInstalledSkills.length > 0) {
        const skillIds = payload.selectedInstalledSkills.map((entry) => entry.id).join(', ');
        const reasonCodes = uniqueSorted(
            payload.selectedInstalledSkills.flatMap((entry) => entry.reason_codes.map((code) => String(code)))
        );
        return `Optional skills: ${skillIds} (reason: ${summarizeReasonCodes(reasonCodes)})`;
    }
    if (payload.decision === 'recommended_missing_packs' && payload.recommendedMissingPacks.length > 0) {
        const packIds = payload.recommendedMissingPacks.map((entry) => entry.id).join(', ');
        const reasonCodes = uniqueSorted(
            payload.recommendedMissingPacks.flatMap((entry) => entry.reason_codes.map((code) => String(code)))
        );
        return `Optional skills: recommended_missing_packs (packs: ${packIds}, reason: ${summarizeReasonCodes(reasonCodes)})`;
    }
    return `Optional skills: as_is (reason: ${payload.asIsReason || 'generic_context_sufficient'})`;
}

export function buildOptionalSkillSelectionArtifact(
    bundleRoot: string,
    taskId: string,
    options: BuildOptionalSkillSelectionOptions = {}
): OptionalSkillSelectionArtifactData {
    const policyConfig = readOptionalSkillSelectionPolicyConfig(bundleRoot);
    const taskText = String(options.taskText || '').trim();
    const changedPaths = uniqueSorted(
        Array.isArray(options.changedPaths)
            ? options.changedPaths.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
            : []
    );
    const taskTextLower = normalizeText(taskText);
    const changedPathsLower = changedPaths.map((entry) => normalizeText(entry));
    const loadedHeadlines = options.loadedHeadlinesCache
        ? {
            headlinesPath: options.loadedHeadlinesCache.headlinesPath,
            headlinesSha256: options.loadedHeadlinesCache.headlinesSha256,
            materializationNeeded: options.loadedHeadlinesCache.materializationNeeded === true,
            skills: options.loadedHeadlinesCache.skills,
            optional_packs: options.loadedHeadlinesCache.optional_packs,
            payload: options.loadedHeadlinesCache.payload || buildSkillsHeadlines(bundleRoot)
        }
        : loadSkillsHeadlines(bundleRoot, policyConfig.mode);
    const headlinesPath = loadedHeadlines?.headlinesPath || getSkillsHeadlinesConfigPath(bundleRoot);
    const availableSkills = loadedHeadlines?.skills || [];
    const optionalPacks = loadedHeadlines?.optional_packs || [];
    const availableSkillIds = new Set(
        availableSkills
            .filter((skill) => skill.source === 'installed_optional' || skill.source === 'custom_live')
            .map((skill) => skill.id)
    );

    let decision: OptionalSkillSelectionDecision = 'as_is';
    let selectedInstalledSkills: OptionalSkillSelectionEntry[] = [];
    let recommendedMissingPacks: OptionalSkillSelectionRecommendedPack[] = [];
    let asIsReason: OptionalSkillSelectionAsIsReason | null = null;

    if (policyConfig.mode === 'off') {
        asIsReason = 'policy_off';
    } else {
        const scoredSkills = selectInstalledSkills(bundleRoot, taskTextLower, changedPathsLower, availableSkills);
        const topSkillScore = scoredSkills[0]?.score || 0;
        selectedInstalledSkills = scoredSkills
            .filter((candidate) => candidate.strong_match && candidate.score >= SKILL_SELECTION_THRESHOLD)
            .slice(0, MAX_SELECTED_SKILLS)
            .map((candidate) => candidate.entry);

        if (selectedInstalledSkills.length > 0) {
            decision = 'selected_installed_skills';
        } else {
            recommendedMissingPacks = selectRecommendedPacks(taskTextLower, changedPathsLower, optionalPacks, availableSkillIds)
                .filter((candidate) => candidate.score >= PACK_RECOMMENDATION_THRESHOLD)
                .slice(0, MAX_RECOMMENDED_PACKS)
                .map((candidate) => candidate.entry);
            if (recommendedMissingPacks.length > 0) {
                decision = 'recommended_missing_packs';
                asIsReason = 'no_relevant_installed_skill';
            } else {
                decision = 'as_is';
                asIsReason = resolveAsIsReason(taskText, changedPaths, topSkillScore, recommendedMissingPacks);
            }
        }
    }

    const visibleSummaryLine = buildVisibleSummaryLine({
        decision,
        selectedInstalledSkills,
        recommendedMissingPacks,
        asIsReason
    });
    const artifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, taskId);
    const preflightPath = options.preflightPath ? String(options.preflightPath).replace(/\\/g, '/') : null;
    const preflightSha256 = typeof options.preflightSha256 === 'string'
        ? options.preflightSha256.trim() || null
        : computeFileSha256(options.preflightPath || null);

    return {
        artifactPath,
        payload: {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            policy_mode: policyConfig.mode,
            decision,
            selected_installed_skills: selectedInstalledSkills,
            recommended_missing_packs: recommendedMissingPacks,
            as_is_reason: asIsReason,
            task_text_present: taskText.length > 0,
            task_text_sha256: computeOptionalSkillTaskTextSha256(taskText),
            changed_paths: changedPaths,
            preflight_path: preflightPath,
            preflight_sha256: preflightSha256,
            headlines_path: toPortableBundlePath(bundleRoot, headlinesPath),
            headlines_sha256: loadedHeadlines?.headlinesSha256 || computeFileSha256(headlinesPath),
            visible_summary_line: visibleSummaryLine
        },
        loadedHeadlinesCache: loadedHeadlines
            ? {
                headlinesPath: loadedHeadlines.headlinesPath,
                headlinesSha256: loadedHeadlines.headlinesSha256,
                materializationNeeded: loadedHeadlines.materializationNeeded,
                skills: loadedHeadlines.skills,
                optional_packs: loadedHeadlines.optional_packs,
                payload: loadedHeadlines.payload
            }
            : null
    };
}
