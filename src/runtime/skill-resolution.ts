import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import { getProjectDiscovery } from '../materialization/project-discovery';
import { emitSkillSuggestedEvent } from './skill-telemetry';

import {
    normalizeOptionalString,
    normalizeNonNegativeInteger,
    normalizeStringArray
} from './skill-manifest';

import {
    readSkillsIndex
} from './skill-index';
import type { SkillsIndexPackEntry, SkillsIndexSkillEntry } from './skill-index';
import { loadSkillsHeadlines } from './optional-skill-selection/headlines-cache';
import type { SkillsHeadlineSkillEntry } from './skill-headlines';

import {
    getSkillPacksConfigPath,
    readInstalledSkillPacks,
    listSkillPacks
} from './skill-activation';

type SignalMatchCategory =
    | 'stack_signals'
    | 'task_signals'
    | 'changed_path_signals'
    | 'project_path_signals'
    | 'aliases_or_tags';

export interface ProjectDiscoveryData {
    source: string;
    detectedStacks: string[];
    topLevelDirectories: string[];
    relativeFiles: string[];
}

export interface SuggestionContext {
    discovery: ProjectDiscoveryData;
    taskText: string;
    taskTextLower: string;
    projectPaths: string[];
    changedPaths: string[];
    textCorpus: string;
    textCorpusLower: string;
}

export interface SignalMatches {
    stack_signals: string[];
    task_signals: string[];
    changed_path_signals: string[];
    project_path_signals: string[];
    aliases_or_tags: string[];
}

export interface SkillSuggestion {
    id: string;
    name: string;
    pack: string;
    summary: string;
    score: number;
    installed: boolean;
    source?: 'builtin_pack' | 'installed_optional' | 'custom_live';
    directory?: string | null;
    matches: SignalMatches;
}

export interface SkillScoringEntry {
    id: string;
    name: string;
    pack: string;
    summary: string;
    tags: string[];
    aliases: string[];
    stack_signals: string[];
    task_signals: string[];
    changed_path_signals: string[];
    priority: number;
    deprecated: boolean;
    implemented: boolean;
    source?: 'builtin_pack' | 'installed_optional' | 'custom_live';
    directory?: string | null;
}

interface PackSuggestionAggregate {
    id: string;
    score: number;
    skillIds: string[];
    matches: SignalMatches;
}

interface PackSuggestion {
    id: string;
    label: string;
    description: string;
    implemented: boolean;
    collidesWithBaseline: boolean;
    score: number;
    installed: boolean;
    skillIds: string[];
    matches: SignalMatches;
}

interface SuggestSkillsOptions {
    taskText?: unknown;
    changedPaths?: unknown;
    limit?: unknown;
    packLimit?: unknown;
    taskId?: unknown;
}

interface DedupeSkillsResult {
    primary: SkillSuggestion[];
    collapsed: SkillSuggestion[];
}

type FuzzyAliasMap = Map<string, string[]>;

const SUGGESTED_SKILL_MIN_SCORE = 75;
const SUGGESTED_PACK_MIN_SCORE = 75;

// Fuzzy alias expansion – deterministic, reviewable synonym groups for
// abbreviation ↔ full-name matching (T-078).
// Each inner array is a group of equivalent terms.  Matching is symmetric:
// if signal says "kubernetes" and text says "k8s" (or vice-versa), the
// alias layer bridges the gap.  All terms are compared lowercased.
export const FUZZY_ALIAS_GROUPS = Object.freeze([
    ['k8s', 'kubernetes', 'kube'],
    ['pg', 'postgres', 'postgresql', 'pgsql'],
    ['js', 'javascript'],
    ['ts', 'typescript'],
    ['dotnet', '.net', 'csharp', 'c#'],
    ['py', 'python'],
    ['rb', 'ruby'],
    ['rs', 'rust'],
    ['tf', 'terraform'],
    ['mongo', 'mongodb'],
    ['gql', 'graphql'],
    ['nodejs', 'node.js'],
    ['reactjs', 'react.js'],
    ['vuejs', 'vue.js'],
    ['nextjs', 'next.js'],
    ['sveltekit', 'svelte-kit'],
    ['expressjs', 'express.js'],
    ['fastapi', 'fast-api'],
]);

let _fuzzyAliasMap: FuzzyAliasMap | null = null;

export function getFuzzyAliasMap(): FuzzyAliasMap {
    if (_fuzzyAliasMap) {
        return _fuzzyAliasMap;
    }
    _fuzzyAliasMap = new Map<string, string[]>();
    for (const group of FUZZY_ALIAS_GROUPS) {
        for (const term of group) {
            const key = term.toLowerCase();
            const aliases = _fuzzyAliasMap.get(key) || [];
            for (const other of group) {
                const otherKey = other.toLowerCase();
                if (otherKey !== key && !aliases.includes(otherKey)) {
                    aliases.push(otherKey);
                }
            }
            _fuzzyAliasMap.set(key, aliases);
        }
    }
    return _fuzzyAliasMap;
}

export function containsAtWordBoundary(text: string, term: string): boolean {
    let startIndex = 0;
    while (startIndex <= text.length - term.length) {
        const idx = text.indexOf(term, startIndex);
        if (idx === -1) {
            return false;
        }
        const before = idx > 0 ? text[idx - 1] : '';
        const after = idx + term.length < text.length ? text[idx + term.length] : '';
        const boundaryBefore = !before || /[^a-z0-9]/.test(before);
        const boundaryAfter = !after || /[^a-z0-9]/.test(after);
        if (boundaryBefore && boundaryAfter) {
            return true;
        }
        startIndex = idx + 1;
    }
    return false;
}

export function getSignalFuzzyVariants(normalizedSignal: string): string[] {
    const aliasMap = getFuzzyAliasMap();
    const variants: string[] = [];
    for (const [term, aliases] of aliasMap) {
        if (!containsAtWordBoundary(normalizedSignal, term)) {
            continue;
        }
        for (const alias of aliases) {
            const variant = normalizedSignal.replace(term, alias);
            if (variant !== normalizedSignal && !variants.includes(variant)) {
                variants.push(variant);
            }
        }
    }
    return variants;
}

export function textMatchesFuzzyVariant(text: string, normalizedSignal: string): boolean {
    const variants = getSignalFuzzyVariants(normalizedSignal);
    for (const variant of variants) {
        if (containsAtWordBoundary(text, variant)) {
            return true;
        }
    }
    return false;
}

function normalizeSearchText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeSignalText(value: unknown): string {
    return normalizeSearchText(value).replace(/\*/g, '').replace(/\\/g, '/');
}

function normalizeChangedPath(targetRoot: string, value: unknown): string | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    if (!path.isAbsolute(text)) {
        return text.replace(/\\/g, '/');
    }

    const resolvedRoot = path.resolve(targetRoot);
    const resolvedPath = path.resolve(text);
    const relativePath = path.relative(resolvedRoot, resolvedPath).replace(/\\/g, '/');
    if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return relativePath;
    }

    return resolvedPath.replace(/\\/g, '/');
}

function textContainsSignal(text: string, signal: string): boolean {
    const normalizedSignal = normalizeSignalText(signal);
    if (!normalizedSignal) {
        return false;
    }
    const normalizedText = normalizeSearchText(text);
    if (normalizedText.includes(normalizedSignal)) {
        return true;
    }
    return textMatchesFuzzyVariant(normalizedText, normalizedSignal);
}

function anyPathMatchesSignal(paths: readonly string[], signal: string): boolean {
    const normalizedSignal = normalizeSignalText(signal);
    if (!normalizedSignal) {
        return false;
    }

    return paths.some((candidate: string) => {
        const normalizedCandidate = String(candidate || '').replace(/\\/g, '/').toLowerCase();
        if (normalizedCandidate.includes(normalizedSignal)) {
            return true;
        }
        return textMatchesFuzzyVariant(normalizedCandidate, normalizedSignal);
    });
}

function getSignalMatches(signals: unknown, matcher: (signal: string) => boolean): string[] {
    const matches: string[] = [];
    const candidates: unknown[] = Array.isArray(signals) ? signals : [];
    for (const signal of candidates) {
        const text = String(signal || '').trim();
        if (!text || matches.includes(text)) {
            continue;
        }
        if (matcher(text)) {
            matches.push(text);
        }
    }
    return matches.sort();
}

function createEmptySignalMatches(): SignalMatches {
    return {
        stack_signals: [],
        task_signals: [],
        changed_path_signals: [],
        project_path_signals: [],
        aliases_or_tags: []
    };
}

export function buildSuggestionContext(targetRoot: string, taskText: unknown, changedPaths: unknown): SuggestionContext {
    const discovery = getProjectDiscovery(targetRoot) as ProjectDiscoveryData;
    const normalizedChangedPaths = normalizeStringArray(changedPaths)
        .map((item) => normalizeChangedPath(targetRoot, item))
        .filter((item): item is string => item !== null);
    const projectPaths = Array.isArray(discovery.relativeFiles) ? discovery.relativeFiles : [];
    const taskTextValue = String(taskText || '').trim();
    const textCorpus = [
        taskTextValue,
        ...discovery.detectedStacks,
        ...discovery.topLevelDirectories,
        ...projectPaths,
        ...normalizedChangedPaths
    ].join('\n');

    return {
        discovery,
        taskText: taskTextValue,
        taskTextLower: normalizeSearchText(taskTextValue),
        projectPaths,
        changedPaths: normalizedChangedPaths,
        textCorpus,
        textCorpusLower: normalizeSearchText(textCorpus)
    };
}

export function scoreSkillSuggestion(
    skill: SkillScoringEntry,
    context: SuggestionContext,
    installedPackIds: readonly string[]
): SkillSuggestion | null {
    const aliasSignals = [
        skill.id,
        skill.name,
        ...skill.aliases
    ];

    const stackMatches = getSignalMatches(skill.stack_signals, (signal: string) => (
        textContainsSignal(context.textCorpusLower, signal) || anyPathMatchesSignal(context.projectPaths, signal)
    ));
    const taskMatches = getSignalMatches(skill.task_signals, (signal: string) => (
        textContainsSignal(context.taskTextLower, signal)
    ));
    const changedPathMatches = getSignalMatches(skill.changed_path_signals, (signal: string) => (
        anyPathMatchesSignal(context.changedPaths, signal)
    ));
    const projectPathMatches = getSignalMatches(skill.changed_path_signals, (signal: string) => (
        anyPathMatchesSignal(context.projectPaths, signal)
    )).filter((signal: string) => !changedPathMatches.includes(signal));
    const aliasMatches = getSignalMatches(aliasSignals, (signal: string) => (
        textContainsSignal(context.taskTextLower, signal) || anyPathMatchesSignal(context.changedPaths, signal)
    ));

    const evidenceCount =
        stackMatches.length +
        taskMatches.length +
        changedPathMatches.length +
        projectPathMatches.length +
        aliasMatches.length;

    if (evidenceCount === 0) {
        return null;
    }

    if (skill.stack_signals.length > 0 && stackMatches.length === 0 && aliasMatches.length === 0) {
        return null;
    }

    let score = 0;
    score += stackMatches.length * 40;
    score += taskMatches.length * 24;
    score += changedPathMatches.length * 30;
    score += projectPathMatches.length * 10;
    score += aliasMatches.length * 12;
    score += Math.min(Number(skill.priority || 0), 100) / 100;
    if (skill.deprecated) {
        score -= 25;
    }

    return {
        id: skill.id,
        name: skill.name,
        pack: skill.pack,
        summary: skill.summary,
        score,
        installed: skill.source === 'custom_live' || skill.source === 'installed_optional' || installedPackIds.includes(skill.pack),
        source: skill.source || (installedPackIds.includes(skill.pack) ? 'installed_optional' : 'builtin_pack'),
        directory: skill.directory || null,
        matches: {
            stack_signals: stackMatches,
            task_signals: taskMatches,
            changed_path_signals: changedPathMatches,
            project_path_signals: projectPathMatches,
            aliases_or_tags: aliasMatches
        }
    };
}

function toIndexScoringEntry(
    skill: SkillsIndexSkillEntry,
    installedPackIds: readonly string[],
    customLiveSkillsById: ReadonlyMap<string, SkillsHeadlineSkillEntry>
): SkillScoringEntry {
    const customLiveSkill = customLiveSkillsById.get(skill.id);
    return {
        ...skill,
        source: customLiveSkill
            ? 'custom_live'
            : installedPackIds.includes(skill.pack)
                ? 'installed_optional'
                : 'builtin_pack',
        directory: customLiveSkill?.directory || null
    };
}

function hasLiveSkillEntrypoint(bundleRoot: string, skill: SkillsHeadlineSkillEntry): boolean {
    const skillDirectory = String(skill.directory || skill.id || '').trim();
    if (!skillDirectory) {
        return false;
    }
    return pathExists(path.join(bundleRoot, 'live', 'skills', skillDirectory, 'SKILL.md'));
}

function getCustomLiveSkills(bundleRoot: string): SkillsHeadlineSkillEntry[] {
    const loadedHeadlines = loadSkillsHeadlines(bundleRoot, 'optional');
    const skills = Array.isArray(loadedHeadlines?.skills) ? loadedHeadlines.skills : [];
    return skills
        .filter((skill) => (
            skill.source === 'custom_live'
            && skill.implemented !== false
            && skill.review_binding === 'general_purpose'
            && hasLiveSkillEntrypoint(bundleRoot, skill)
        ))
        .sort((left, right) => left.id.localeCompare(right.id));
}

function toCustomLiveScoringEntry(skill: SkillsHeadlineSkillEntry): SkillScoringEntry {
    return {
        id: skill.id,
        name: skill.name,
        pack: skill.pack || 'custom',
        summary: skill.summary,
        tags: [...skill.tags],
        aliases: [...skill.aliases],
        stack_signals: [],
        task_signals: [...skill.task_signals],
        changed_path_signals: [...skill.changed_path_signals],
        priority: 50,
        deprecated: false,
        implemented: skill.implemented !== false,
        source: 'custom_live',
        directory: skill.directory || skill.id
    };
}

function isSkillAvailableLocally(skill: SkillSuggestion, liveSkillDirectorySet: ReadonlySet<string>): boolean {
    if (skill.source === 'custom_live') {
        return true;
    }
    const directory = String(skill.directory || '').trim();
    return liveSkillDirectorySet.has(skill.id) || (!!directory && liveSkillDirectorySet.has(directory));
}

// Same-pack dedupe – keeps the top-N suggestion list diverse across packs
// (T-080).  The strongest skill per pack is always preserved.  Additional
// same-pack skills survive only when they contribute evidence in a signal
// category the primary skill does not cover.
export const MATCH_CATEGORIES = Object.freeze([
    'stack_signals', 'task_signals', 'changed_path_signals',
    'project_path_signals', 'aliases_or_tags'
]) as readonly SignalMatchCategory[];

export function hasDistinctSignalCoverage(primarySkill: SkillSuggestion, candidateSkill: SkillSuggestion): boolean {
    const pm = primarySkill.matches;
    const cm = candidateSkill.matches;
    for (const category of MATCH_CATEGORIES) {
        const primaryMatches = pm ? pm[category] : undefined;
        const candidateMatches = cm ? cm[category] : undefined;
        const primaryEmpty = !primaryMatches || primaryMatches.length === 0;
        const candidateHas = candidateMatches != null && candidateMatches.length > 0;
        if (primaryEmpty && candidateHas) {
            return true;
        }
    }
    return false;
}

export function dedupeSkillsByPack(sortedSkills: readonly SkillSuggestion[]): DedupeSkillsResult {
    const topByPack = new Map<string, SkillSuggestion>();
    const primary: SkillSuggestion[] = [];
    const collapsed: SkillSuggestion[] = [];

    for (const skill of sortedSkills) {
        const existing = topByPack.get(skill.pack);
        if (!existing) {
            topByPack.set(skill.pack, skill);
            primary.push(skill);
            continue;
        }
        if (hasDistinctSignalCoverage(existing, skill)) {
            primary.push(skill);
            continue;
        }
        collapsed.push(skill);
    }

    return { primary, collapsed };
}

function aggregatePackSuggestions(
    skillSuggestions: readonly SkillSuggestion[],
    packIndex: Map<string, SkillsIndexPackEntry>,
    installedPackIds: readonly string[]
): PackSuggestion[] {
    const byPackId = new Map<string, PackSuggestionAggregate>();

    for (const suggestion of skillSuggestions) {
        const existing = byPackId.get(suggestion.pack) || {
            id: suggestion.pack,
            score: 0,
            skillIds: [],
            matches: createEmptySignalMatches()
        };

        existing.score = Math.max(existing.score, suggestion.score);
        existing.skillIds.push(suggestion.id);

        for (const key of MATCH_CATEGORIES) {
            for (const item of suggestion.matches[key]) {
                if (!existing.matches[key].includes(item)) {
                    existing.matches[key].push(item);
                }
            }
        }

        byPackId.set(suggestion.pack, existing);
    }

    return Array.from(byPackId.values())
        .map((entry: PackSuggestionAggregate) => {
            const pack = packIndex.get(entry.id);
            return {
                id: entry.id,
                label: pack?.label ?? entry.id,
                description: pack?.description ?? '',
                implemented: pack?.implemented !== false,
                collidesWithBaseline: pack?.collides_with_baseline === true,
                score: entry.score,
                installed: installedPackIds.includes(entry.id),
                skillIds: entry.skillIds.sort(),
                matches: entry.matches
            };
        })
        .sort((left: PackSuggestion, right: PackSuggestion) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.id.localeCompare(right.id);
        });
}

export function suggestSkills(bundleRoot: string, targetRoot: string, options: SuggestSkillsOptions = {}) {
    const { indexPath, payload } = readSkillsIndex(bundleRoot);
    const { installedPackIds } = readInstalledSkillPacks(bundleRoot);
    const listing = listSkillPacks(bundleRoot, { refreshHeadlines: false });
    const liveSkillDirectorySet = new Set(listing.liveSkillDirectories);
    const context = buildSuggestionContext(targetRoot, options.taskText || '', options.changedPaths || []);
    const packIndex = new Map<string, SkillsIndexPackEntry>(payload.packs.map((pack: SkillsIndexPackEntry) => [pack.id, pack]));
    const limit = normalizeNonNegativeInteger(options.limit, 7) || 7;
    const packLimit = normalizeNonNegativeInteger(options.packLimit, 5) || 5;
    const customLiveSkills = getCustomLiveSkills(bundleRoot);
    const customLiveSkillsById = new Map(customLiveSkills.map((skill) => [skill.id, skill]));
    const indexedSkillIds = new Set(payload.skills.map((skill: SkillsIndexSkillEntry) => skill.id));
    const supplementalCustomLiveSkills = customLiveSkills
        .filter((skill) => !indexedSkillIds.has(skill.id))
        .map(toCustomLiveScoringEntry);

    const allSkillSuggestions = [
        ...payload.skills
            .filter((skill: SkillsIndexSkillEntry) => skill.implemented !== false)
            .map((skill: SkillsIndexSkillEntry) => toIndexScoringEntry(skill, installedPackIds, customLiveSkillsById)),
        ...supplementalCustomLiveSkills
    ]
        .filter((skill) => skill.implemented !== false)
        .map((skill) => scoreSkillSuggestion(skill, context, installedPackIds))
        .filter((skill): skill is SkillSuggestion => skill !== null)
        .sort((left: SkillSuggestion, right: SkillSuggestion) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.id.localeCompare(right.id);
        });

    const availableRelevantSkillsFull = allSkillSuggestions.filter((skill: SkillSuggestion) => (
        isSkillAvailableLocally(skill, liveSkillDirectorySet)
    ));
    const suggestedSkillsFull = allSkillSuggestions.filter((skill: SkillSuggestion) => (
        !isSkillAvailableLocally(skill, liveSkillDirectorySet) &&
        skill.score >= SUGGESTED_SKILL_MIN_SCORE
    ));

    // Pack aggregation uses the full (non-deduped) skill lists so pack
    // scores and match summaries remain comprehensive.
    const availableRelevantPacks = aggregatePackSuggestions(
        availableRelevantSkillsFull.filter((skill) => skill.source !== 'custom_live'),
        packIndex,
        installedPackIds
    );
    const suggestedPacks = aggregatePackSuggestions(suggestedSkillsFull, packIndex, installedPackIds)
        .filter((pack) => !pack.installed && pack.score >= SUGGESTED_PACK_MIN_SCORE);

    // Dedupe same-pack skills to keep top-N diverse across packs (T-080).
    const suggestedDedupe = dedupeSkillsByPack(suggestedSkillsFull);
    const availableDedupe = dedupeSkillsByPack(availableRelevantSkillsFull);

    const cappedSuggestedSkills = suggestedDedupe.primary.slice(0, limit);

    // Emit skill_suggested telemetry when a taskId is provided.
    const taskId = normalizeOptionalString(options.taskId);
    if (taskId) {
        for (const suggestion of cappedSuggestedSkills) {
            emitSkillSuggestedEvent(bundleRoot, taskId, {
                id: suggestion.id,
                pack: suggestion.pack,
                score: suggestion.score,
                matches: null
            }, 'context_match', undefined);
        }
    }

    return {
        bundleRoot,
        targetRoot: path.resolve(targetRoot),
        indexPath,
        configPath: getSkillPacksConfigPath(bundleRoot),
        installedPackIds,
        baselineSkillDirectories: [...listing.baselineSkillDirectories],
        liveSkillDirectories: [...listing.liveSkillDirectories],
        installedOptionalSkillDirectories: [...listing.installedOptionalSkillDirectories],
        customSkillDirectories: [...listing.customSkillDirectories],
        taskText: context.taskText,
        changedPaths: context.changedPaths,
        discovery: {
            source: context.discovery.source,
            detectedStacks: context.discovery.detectedStacks,
            topLevelDirectories: context.discovery.topLevelDirectories
        },
        availableRelevantPacks: availableRelevantPacks.slice(0, packLimit),
        availableRelevantSkills: availableDedupe.primary.slice(0, limit),
        suggestedPacks: suggestedPacks.slice(0, packLimit),
        suggestedSkills: cappedSuggestedSkills,
        collapsedSamePackSkills: suggestedDedupe.collapsed,
        collapsedAvailableRelevantSkills: availableDedupe.collapsed
    };
}
