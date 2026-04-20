import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDirectory, pathExists } from '../core/fs';
import { formatJson, readJsonFile, writeJsonFile } from '../core/json';
import { validateManagedConfigByName } from '../schemas/config-artifacts';
import {
    buildSkillsHeadlines,
    computeCurrentSkillsHeadlinesSourceState,
    computeCurrentSkillsHeadlinesValidationState,
    computeSkillsHeadlinesSelectionSurfaceSha256,
    ensureSkillsHeadlinesCurrent,
    getSkillsHeadlinesConfigPath,
    readSkillsHeadlinesIfPresent,
    type SkillsHeadlinesPayload,
    type SkillsHeadlinePackEntry,
    type SkillsHeadlineSkillEntry
} from './skill-headlines';
import { BASELINE_SKILL_DIRECTORIES } from './skill-manifest';
import { readInstalledSkillPacks } from './skill-activation';
import {
    containsAtWordBoundary,
    textMatchesFuzzyVariant
} from './skill-resolution';

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

type OptionalSkillSelectionDecision =
    | 'selected_installed_skills'
    | 'recommended_missing_packs'
    | 'as_is';

interface MatchGroups {
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

interface BuildOptionalSkillSelectionOptions {
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

interface WriteOptionalSkillSelectionOptions extends BuildOptionalSkillSelectionOptions {
    preparedArtifact?: OptionalSkillSelectionArtifactData | null;
}

interface SkillCandidateScore {
    entry: OptionalSkillSelectionEntry;
    score: number;
    strong_match: boolean;
}

interface PackCandidateScore {
    entry: OptionalSkillSelectionRecommendedPack;
    score: number;
}

interface LoadedSkillsHeadlinesData {
    headlinesPath: string;
    headlinesSha256: string | null;
    materializationNeeded: boolean;
    skills: SkillsHeadlineSkillEntry[];
    optional_packs: SkillsHeadlinePackEntry[];
    payload: SkillsHeadlinesPayload;
}

interface LoadSkillsHeadlinesOptions {
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

const DEFAULT_POLICY_CONFIG: OptionalSkillSelectionPolicyConfig = Object.freeze({
    version: 1,
    mode: 'advisory'
});

const MAX_SELECTED_SKILLS = 2;
const MAX_RECOMMENDED_PACKS = 3;
const SKILL_SELECTION_THRESHOLD = 60;
const PACK_RECOMMENDATION_THRESHOLD = 60;

const COMMON_SIGNAL_STOP_WORDS = new Set([
    'and',
    'for',
    'the',
    'with',
    'into',
    'from',
    'like',
    'work',
    'task',
    'flow',
    'mode',
    'this',
    'that',
    'across',
    'safety',
    'delivery',
    'production',
    'general',
    'purpose'
]);

function normalizeText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function uniqueSorted(items: string[]): string[] {
    return [...new Set(items.filter(Boolean))].sort();
}

export function computeOptionalSkillTaskTextSha256(taskText: string): string | null {
    const normalizedTaskText = String(taskText || '').trim();
    if (!normalizedTaskText) {
        return null;
    }
    return createHash('sha256').update(normalizedTaskText, 'utf8').digest('hex');
}

function readValidatedConfig(configPath: string): Record<string, unknown> {
    const raw = readJsonFile(configPath);
    return validateManagedConfigByName('optional-skill-selection-policy', raw);
}

function isManagedConfigMapped(bundleRoot: string, configName: string): boolean {
    const rootConfigPath = path.join(bundleRoot, 'live', 'config', 'garda.config.json');
    if (!pathExists(rootConfigPath)) {
        return false;
    }
    try {
        const raw = readJsonFile(rootConfigPath) as Record<string, unknown>;
        const configs = raw.configs;
        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
            return false;
        }
        const mappedPath = (configs as Record<string, unknown>)[configName];
        return typeof mappedPath === 'string' && mappedPath.trim().length > 0;
    } catch {
        return false;
    }
}

function computeFileSha256(filePath: string | null | undefined): string | null {
    if (!filePath || !pathExists(filePath)) {
        return null;
    }
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function computeSkillsHeadlinesPayloadSha256(payload: SkillsHeadlinesPayload): string {
    return createHash('sha256').update(formatJson(payload), 'utf8').digest('hex');
}

function selectLatestTimestamp(
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

function resolvePortableRepoPath(bundleRoot: string, portablePath: string): string {
    const normalizedPath = String(portablePath || '').trim();
    if (!normalizedPath) {
        return '';
    }
    if (path.isAbsolute(normalizedPath)) {
        return path.resolve(normalizedPath);
    }
    return path.resolve(path.dirname(path.resolve(bundleRoot)), normalizedPath);
}

function toPortableBundlePath(bundleRoot: string, absolutePath: string): string {
    const orchestratorRoot = path.resolve(bundleRoot);
    const relative = path.relative(path.dirname(orchestratorRoot), absolutePath).replace(/\\/g, '/');
    if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)) {
        return relative;
    }
    return absolutePath.replace(/\\/g, '/');
}

function buildEmptyMatches(): MatchGroups {
    return {
        task_signals: [],
        changed_path_signals: []
    };
}

function addMatch(target: string[], signal: string): void {
    const normalized = String(signal || '').trim();
    if (!normalized || target.includes(normalized)) {
        return;
    }
    target.push(normalized);
}

function textContainsSignal(text: string, signal: string): boolean {
    const normalizedSignal = normalizeText(signal).replace(/\*/g, '');
    if (!normalizedSignal) {
        return false;
    }
    return containsAtWordBoundary(text, normalizedSignal) || textMatchesFuzzyVariant(text, normalizedSignal);
}

function pathContainsSignal(paths: readonly string[], signal: string): boolean {
    const normalizedSignal = normalizeText(signal);
    if (!normalizedSignal) {
        return false;
    }
    return paths.some((candidate) => textContainsSignal(candidate, normalizedSignal));
}

function splitTextSignals(value: string): string[] {
    const normalized = normalizeText(value);
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/[^a-z0-9.#/+_-]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length >= 4 && !COMMON_SIGNAL_STOP_WORDS.has(entry));
}

function isDocumentationLikePath(value: string): boolean {
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

function skillLooksDocumentationOrProcess(skill: SkillsHeadlineSkillEntry): boolean {
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

function hasNonDocumentationChangedPaths(paths: readonly string[]): boolean {
    return paths.some((entry) => !isDocumentationLikePath(entry));
}

function collectPrimarySignals(skill: SkillsHeadlineSkillEntry): string[] {
    return uniqueSorted([
        skill.id,
        skill.name,
        ...(Array.isArray(skill.aliases) ? skill.aliases : []),
        ...(Array.isArray(skill.task_signals) ? skill.task_signals : []),
        ...(Array.isArray(skill.changed_path_signals) ? skill.changed_path_signals : [])
    ].map((entry) => normalizeText(entry)).filter(Boolean));
}

function collectSecondarySignals(skill: SkillsHeadlineSkillEntry): string[] {
    const summarySignals = splitTextSignals(skill.summary || '');
    return uniqueSorted([
        ...(Array.isArray(skill.tags) ? skill.tags : []),
        ...summarySignals
    ].map((entry) => normalizeText(entry)).filter(Boolean));
}

function scoreSignalBuckets(
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

function getReasonCodes(matches: MatchGroups): Array<'task_signals' | 'changed_path_signals'> {
    const reasons: Array<'task_signals' | 'changed_path_signals'> = [];
    if (matches.task_signals.length > 0) {
        reasons.push('task_signals');
    }
    if (matches.changed_path_signals.length > 0) {
        reasons.push('changed_path_signals');
    }
    return reasons;
}

function summarizeReasonCodes(reasonCodes: readonly string[]): string {
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

function selectInstalledSkills(
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

function selectRecommendedPacks(
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

function resolveAsIsReason(
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

function buildVisibleSummaryLine(payload: {
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

function loadSkillsHeadlines(
    bundleRoot: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    options: LoadSkillsHeadlinesOptions = {}
): LoadedSkillsHeadlinesData | null {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    if (policyMode === 'off') {
        return null;
    }

    const persistedHeadlines = readSkillsHeadlinesIfPresent(bundleRoot);
    if (persistedHeadlines && options.preferPersistedSurface === true) {
        const currentSourceState = computeCurrentSkillsHeadlinesSourceState(bundleRoot);
        if (
            String(persistedHeadlines.payload.source_state_sha256 || '') === currentSourceState.sourceStateSha256
            && String(persistedHeadlines.payload.source_state_hint_sha256 || '') === currentSourceState.sourceStateHintSha256
        ) {
            return {
                headlinesPath: persistedHeadlines.headlinesPath,
                headlinesSha256: persistedHeadlines.sha256,
                materializationNeeded: false,
                skills: Array.isArray(persistedHeadlines.payload.skills) ? persistedHeadlines.payload.skills : [],
                optional_packs: Array.isArray(persistedHeadlines.payload.optional_packs)
                    ? persistedHeadlines.payload.optional_packs
                    : [],
                payload: persistedHeadlines.payload
            };
        }
    }
    const currentValidationState = computeCurrentSkillsHeadlinesValidationState(bundleRoot);
    if (
        persistedHeadlines
        && String(persistedHeadlines.payload.source_state_sha256 || '') === currentValidationState.sourceStateSha256
        && String(persistedHeadlines.payload.source_state_hint_sha256 || '') === currentValidationState.sourceStateHintSha256
        && computeSkillsHeadlinesSelectionSurfaceSha256(persistedHeadlines.payload) === currentValidationState.selectionSurfaceSha256
    ) {
        return {
            headlinesPath: persistedHeadlines.headlinesPath,
            headlinesSha256: persistedHeadlines.sha256,
            materializationNeeded: false,
            skills: Array.isArray(persistedHeadlines.payload.skills) ? persistedHeadlines.payload.skills : [],
            optional_packs: Array.isArray(persistedHeadlines.payload.optional_packs)
                ? persistedHeadlines.payload.optional_packs
                : [],
            payload: persistedHeadlines.payload
        };
    }
    return {
        headlinesPath,
        headlinesSha256: createHash('sha256').update(formatJson(currentValidationState.payload), 'utf8').digest('hex'),
        materializationNeeded: true,
        skills: Array.isArray(currentValidationState.payload.skills) ? currentValidationState.payload.skills : [],
        optional_packs: Array.isArray(currentValidationState.payload.optional_packs)
            ? currentValidationState.payload.optional_packs
            : [],
        payload: currentValidationState.payload
    };
}

export function loadOptionalSkillSelectionHeadlinesCache(
    bundleRoot: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    options: LoadSkillsHeadlinesOptions = {}
): OptionalSkillSelectionArtifactData['loadedHeadlinesCache'] {
    const loadedHeadlines = loadSkillsHeadlines(bundleRoot, policyMode, options);
    if (!loadedHeadlines) {
        return null;
    }
    return {
        headlinesPath: loadedHeadlines.headlinesPath,
        headlinesSha256: loadedHeadlines.headlinesSha256,
        materializationNeeded: loadedHeadlines.materializationNeeded,
        skills: loadedHeadlines.skills,
        optional_packs: loadedHeadlines.optional_packs,
        payload: loadedHeadlines.payload
    };
}

function materializeCurrentHeadlinesSurface(
    bundleRoot: string,
    loadedHeadlinesCache?: OptionalSkillSelectionArtifactData['loadedHeadlinesCache']
): { headlinesPath: string; headlinesSha256: string | null; payload: SkillsHeadlinesPayload } {
    if (loadedHeadlinesCache?.payload) {
        if (loadedHeadlinesCache.materializationNeeded || !pathExists(loadedHeadlinesCache.headlinesPath)) {
            ensureDirectory(path.dirname(loadedHeadlinesCache.headlinesPath));
            const serializedPayload = formatJson(loadedHeadlinesCache.payload);
            const existingSerializedPayload = pathExists(loadedHeadlinesCache.headlinesPath)
                ? fs.readFileSync(loadedHeadlinesCache.headlinesPath, 'utf8').trim()
                : null;
            if (existingSerializedPayload !== serializedPayload) {
                writeJsonFile(loadedHeadlinesCache.headlinesPath, loadedHeadlinesCache.payload);
            }
        }
        return {
            headlinesPath: loadedHeadlinesCache.headlinesPath,
            headlinesSha256: loadedHeadlinesCache.headlinesSha256 || computeSkillsHeadlinesPayloadSha256(loadedHeadlinesCache.payload),
            payload: loadedHeadlinesCache.payload
        };
    }

    const currentHeadlines = ensureSkillsHeadlinesCurrent(bundleRoot);
    return {
        headlinesPath: currentHeadlines.headlinesPath,
        headlinesSha256: currentHeadlines.sha256,
        payload: currentHeadlines.payload
    };
}

export function readOptionalSkillSelectionTimelineEvidence(
    bundleRoot: string,
    taskId: string,
    taskEventsPath?: string | null
): OptionalSkillSelectionTimelineEvidence {
    const resolvedTaskEventsPath = taskEventsPath
        ? path.resolve(taskEventsPath)
        : path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const eventTypes = new Set<string>();
    const optionalSkillActivations: OptionalSkillSelectionActivationEvidence[] = [];
    const optionalSkillReferenceLoads: OptionalSkillSelectionReferenceLoadEvidence[] = [];
    let latestTaskModeEnteredTimestampUtc: string | null = null;
    let latestCycleBoundaryTimestampUtc: string | null = null;

    if (!pathExists(resolvedTaskEventsPath)) {
        return {
            timelinePath: resolvedTaskEventsPath,
            exists: false,
            invalidJson: false,
            eventTypes,
            latestTaskModeEnteredTimestampUtc,
            latestCycleBoundaryTimestampUtc,
            optionalSkillActivations,
            optionalSkillReferenceLoads
        };
    }

    const liveSkillsRoot = normalizeText(path.join(bundleRoot, 'live', 'skills'));
    let invalidJson = false;
    for (const rawLine of fs.readFileSync(resolvedTaskEventsPath, 'utf8').split(/\r?\n/)) {
        if (!rawLine.trim()) {
            continue;
        }
        let parsedLine: Record<string, unknown> | null = null;
        try {
            parsedLine = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            invalidJson = true;
            break;
        }
        const eventType = String(parsedLine.event_type || '').trim().toUpperCase();
        const eventTimestampUtc = String(parsedLine.timestamp_utc || '').trim() || null;
        if (eventType) {
            eventTypes.add(eventType);
        }
        if (eventType === 'TASK_MODE_ENTERED') {
            latestTaskModeEnteredTimestampUtc = selectLatestTimestamp(
                latestTaskModeEnteredTimestampUtc,
                eventTimestampUtc
            );
        }
        if (eventType === 'TASK_MODE_ENTERED' || eventType === 'PREFLIGHT_STARTED' || eventType === 'PREFLIGHT_CLASSIFIED') {
            latestCycleBoundaryTimestampUtc = selectLatestTimestamp(
                latestCycleBoundaryTimestampUtc,
                eventTimestampUtc
            );
        }
        const details = parsedLine.details;
        if (eventType === 'SKILL_SELECTED' && details && typeof details === 'object' && !Array.isArray(details)) {
            const detailRecord = details as Record<string, unknown>;
            const triggerReason = String(detailRecord.trigger_reason || '').trim();
            if (triggerReason === 'optional_skill_selection') {
                optionalSkillActivations.push({
                    skillId: String(detailRecord.skill_id || '').trim() || null,
                    triggerReason: triggerReason || null,
                    timestampUtc: eventTimestampUtc
                });
            }
        }
        if (eventType !== 'SKILL_REFERENCE_LOADED') {
            continue;
        }
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            continue;
        }
        const detailRecord = details as Record<string, unknown>;
        const triggerReason = String(detailRecord.trigger_reason || '').trim();
        if (triggerReason === 'review_skill') {
            continue;
        }
        const referencePath = String(detailRecord.reference_path || '').trim();
        if (!referencePath) {
            continue;
        }
        const resolvedReferencePath = resolvePortableRepoPath(bundleRoot, referencePath);
        if (!normalizeText(resolvedReferencePath).startsWith(liveSkillsRoot)) {
            continue;
        }
        const relativeReferencePath = path.relative(path.join(bundleRoot, 'live', 'skills'), resolvedReferencePath).replace(/\\/g, '/');
        const skillDirectory = relativeReferencePath.split('/').filter(Boolean)[0] || '';
        if (BASELINE_SKILL_DIRECTORIES.includes(skillDirectory)) {
            continue;
        }
        optionalSkillReferenceLoads.push({
            skillId: String(detailRecord.skill_id || '').trim() || null,
            referencePath,
            resolvedReferencePath,
            triggerReason: triggerReason || null,
            timestampUtc: String(parsedLine.timestamp_utc || '').trim() || null
        });
    }

    return {
        timelinePath: resolvedTaskEventsPath,
        exists: true,
        invalidJson,
        eventTypes,
        latestTaskModeEnteredTimestampUtc,
        latestCycleBoundaryTimestampUtc,
        optionalSkillActivations,
        optionalSkillReferenceLoads
    };
}

function toTimestampMs(value: string | null | undefined): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

export function getCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    const lowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    return timelineEvidence.optionalSkillReferenceLoads.filter((entry) => {
        if (lowerBoundTimestampMs === null) {
            return true;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        return eventTimestampMs !== null && eventTimestampMs >= lowerBoundTimestampMs;
    });
}

function getCurrentCycleOptionalSkillActivations(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionActivationEvidence[] {
    const lowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    return timelineEvidence.optionalSkillActivations.filter((entry) => {
        if (lowerBoundTimestampMs === null) {
            return true;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        return eventTimestampMs !== null && eventTimestampMs >= lowerBoundTimestampMs;
    });
}

function buildCurrentCycleOptionalSkillActivationIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const activationIndex = new Map<string, number>();
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const previousTimestampMs = activationIndex.get(skillId);
        if (previousTimestampMs === undefined || timestampMs > previousTimestampMs) {
            activationIndex.set(skillId, timestampMs);
        }
    }
    return activationIndex;
}

export function getActivatedCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    if (timelineEvidence.invalidJson) {
        return [];
    }
    const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(payload, timelineEvidence);
    return getCurrentCycleOptionalSkillReferenceLoads(payload, timelineEvidence).filter((entry) => {
        const skillId = String(entry.skillId || '').trim();
        const activationTimestampMs = activationIndex.get(skillId);
        if (!skillId || activationTimestampMs === undefined) {
            return false;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        return eventTimestampMs !== null && eventTimestampMs >= activationTimestampMs;
    });
}

function isPathWithinResolvedRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRootPath = path.resolve(rootPath);
    const resolvedCandidatePath = path.resolve(candidatePath);
    const relativePath = path.relative(resolvedRootPath, resolvedCandidatePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function collectOptionalSkillReferenceLoadViolations(
    bundleRoot: string,
    taskId: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    payload: OptionalSkillSelectionArtifact,
    taskEventsPath?: string | null,
    timelineEvidence?: OptionalSkillSelectionTimelineEvidence | null
): string[] {
    const resolvedTimelineEvidence = timelineEvidence || readOptionalSkillSelectionTimelineEvidence(bundleRoot, taskId, taskEventsPath);
    if (!resolvedTimelineEvidence.exists || resolvedTimelineEvidence.invalidJson) {
        return [];
    }

    const allowedPaths = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => resolvePortableRepoPath(bundleRoot, String(entry.allowed_skill_path || '').trim()))
                .filter(Boolean)
            : []
    );
    const allowedRoots = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => resolvePortableRepoPath(bundleRoot, String(entry.allowed_skill_path || '').trim()))
                .filter(Boolean)
                .map((resolvedPath) => path.dirname(resolvedPath))
            : []
    );
    const selectedSkillIds = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => String(entry.id || '').trim())
                .filter(Boolean)
            : []
    );
    const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(payload, resolvedTimelineEvidence);
    const violations: string[] = [];
    for (const referenceLoad of getCurrentCycleOptionalSkillReferenceLoads(payload, resolvedTimelineEvidence)) {
        if (policyMode === 'off') {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded while policy mode is 'off'.`
            );
            continue;
        }
        const isAuthorized = allowedPaths.has(referenceLoad.resolvedReferencePath)
            || [...allowedRoots].some((allowedRoot) => isPathWithinResolvedRoot(allowedRoot, referenceLoad.resolvedReferencePath));
        if (!isAuthorized) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' is not authorized by the current optional skill selection artifact.`
            );
            continue;
        }
        const activatedSkillId = String(referenceLoad.skillId || '').trim();
        const activationTimestampMs = activationIndex.get(activatedSkillId);
        if (!activatedSkillId || !selectedSkillIds.has(activatedSkillId) || activationTimestampMs === undefined) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded before the selected optional skill was activated for the current task cycle.`
            );
            continue;
        }
        const referenceTimestampMs = toTimestampMs(referenceLoad.timestampUtc);
        if (referenceTimestampMs === null || referenceTimestampMs < activationTimestampMs) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded before optional skill activation completed for the current task cycle.`
            );
            continue;
        }
    }

    return violations;
}

export function getOptionalSkillSelectionArtifactViolations(
    bundleRoot: string,
    artifact: OptionalSkillSelectionArtifactData,
    options: {
        requireMaterializedArtifact?: boolean;
        expectedPreflightPath?: string | null;
        expectedPreflightSha256?: string | null;
        expectedTaskTextSha256?: string | null;
        expectedPolicyMode?: OptionalSkillSelectionPolicyMode | null;
        validateAgainstCurrentHeadlines?: boolean;
        validateAgainstCurrentInventory?: boolean;
        loadedHeadlinesCache?: {
            headlinesPath: string;
            headlinesSha256: string | null;
            materializationNeeded?: boolean;
            skills: SkillsHeadlineSkillEntry[];
            optional_packs: SkillsHeadlinePackEntry[];
        } | null;
    } = {}
): string[] {
    const violations: string[] = [];
    const { payload } = artifact;
    const schemaVersion = Number(payload.schema_version || 0);
    const eventSource = String(payload.event_source || '').trim();
    const policyMode = String(payload.policy_mode || '').trim() as OptionalSkillSelectionPolicyMode;
    const decision = String(payload.decision || '').trim() as OptionalSkillSelectionDecision;
    const expectedArtifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, payload.task_id);
    const validateAgainstCurrentHeadlines = options.validateAgainstCurrentHeadlines !== false;
    const validateAgainstCurrentInventory = options.validateAgainstCurrentInventory !== false;
    const allowedDecisions = new Set<OptionalSkillSelectionDecision>([
        'selected_installed_skills',
        'recommended_missing_packs',
        'as_is'
    ]);

    if (options.requireMaterializedArtifact === true && !pathExists(artifact.artifactPath)) {
        violations.push(
            `Optional skill selection artifact is missing for current task cycle: ${toPortableBundlePath(bundleRoot, artifact.artifactPath)}`
        );
    }

    if (path.resolve(artifact.artifactPath) !== path.resolve(expectedArtifactPath)) {
        violations.push(
            `Optional skill selection artifact path must match the canonical location '${toPortableBundlePath(bundleRoot, expectedArtifactPath)}'.`
        );
    }
    if (schemaVersion !== 1) {
        violations.push(`Optional skill selection artifact schema_version '${schemaVersion}' is invalid.`);
    }
    if (eventSource !== 'optional-skill-selection') {
        violations.push("Optional skill selection artifact event_source must equal 'optional-skill-selection'.");
    }

    if (!OPTIONAL_SKILL_SELECTION_POLICY_MODES.includes(policyMode)) {
        violations.push(`Optional skill selection policy mode '${policyMode}' is invalid.`);
    }
    const expectedPolicyMode = String(options.expectedPolicyMode || '').trim() as OptionalSkillSelectionPolicyMode;
    if (expectedPolicyMode && policyMode !== expectedPolicyMode) {
        violations.push(`Optional skill selection artifact must match the current policy mode '${expectedPolicyMode}'.`);
    }
    if (!allowedDecisions.has(decision)) {
        violations.push(`Optional skill selection decision '${decision}' is invalid.`);
    }
    if (!String(payload.visible_summary_line || '').trim()) {
        violations.push('Optional skill selection artifact must include a compact visible_summary_line.');
    }

    const selectedSkills = Array.isArray(payload.selected_installed_skills) ? payload.selected_installed_skills : [];
    const recommendedMissingPacks = Array.isArray(payload.recommended_missing_packs)
        ? payload.recommended_missing_packs
        : [];
    const selectedSkillIds = selectedSkills
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean);
    const recommendedPackIds = recommendedMissingPacks
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean);
    const loadedHeadlines = (
        validateAgainstCurrentHeadlines
        || validateAgainstCurrentInventory
    )
        ? (options.loadedHeadlinesCache
            ? {
                headlinesPath: options.loadedHeadlinesCache.headlinesPath,
                headlinesSha256: options.loadedHeadlinesCache.headlinesSha256,
                materializationNeeded: options.loadedHeadlinesCache.materializationNeeded === true,
                payload: {
                    skills: options.loadedHeadlinesCache.skills,
                    optional_packs: options.loadedHeadlinesCache.optional_packs
                }
            }
            : artifact.loadedHeadlinesCache
                ? {
                    headlinesPath: artifact.loadedHeadlinesCache.headlinesPath,
                    headlinesSha256: artifact.loadedHeadlinesCache.headlinesSha256,
                    materializationNeeded: artifact.loadedHeadlinesCache.materializationNeeded === true,
                    payload: {
                        skills: artifact.loadedHeadlinesCache.skills,
                        optional_packs: artifact.loadedHeadlinesCache.optional_packs
                    }
                }
                : loadSkillsHeadlines(bundleRoot, policyMode))
        : null;
    const currentSelectableSkillsById = new Map<string, SkillsHeadlineSkillEntry>(
        (validateAgainstCurrentInventory ? (loadedHeadlines?.payload.skills || []) : [])
            .filter((skill) => (
                skill.review_binding === 'general_purpose'
                && (skill.source === 'installed_optional' || skill.source === 'custom_live')
                && skill.implemented !== false
            ))
            .map((skill) => [skill.id, skill])
    );
    const currentOptionalPacksById = new Map<string, SkillsHeadlinePackEntry>(
        (validateAgainstCurrentInventory ? (loadedHeadlines?.payload.optional_packs || []) : []).map((pack) => [pack.id, pack])
    );
    const currentInstalledPackIds = validateAgainstCurrentInventory
        ? new Set(readInstalledSkillPacks(bundleRoot).installedPackIds)
        : new Set<string>();
    if (loadedHeadlines && validateAgainstCurrentHeadlines) {
        const expectedHeadlinesPath = toPortableBundlePath(bundleRoot, loadedHeadlines.headlinesPath);
        if (String(payload.headlines_path || '').trim() !== expectedHeadlinesPath) {
            violations.push(
                `Optional skill selection artifact must bind to the current headlines surface '${expectedHeadlinesPath}'.`
            );
        }
        if (
            loadedHeadlines.headlinesSha256
            && String(payload.headlines_sha256 || '').trim()
            && String(payload.headlines_sha256 || '').trim() !== loadedHeadlines.headlinesSha256
        ) {
            violations.push('Optional skill selection artifact does not match the current skills-headlines surface hash.');
        }
    }

    const expectedPreflightPath = String(options.expectedPreflightPath || '').trim();
    if (expectedPreflightPath) {
        const expectedPortablePreflightPath = expectedPreflightPath.replace(/\\/g, '/');
        if (String(payload.preflight_path || '').trim() !== expectedPortablePreflightPath) {
            violations.push(
                `Optional skill selection artifact must bind to the current preflight artifact '${expectedPortablePreflightPath}'.`
            );
        }
    }

    const expectedPreflightSha256 = String(options.expectedPreflightSha256 || '').trim();
    if (expectedPreflightSha256 && String(payload.preflight_sha256 || '').trim() !== expectedPreflightSha256) {
        violations.push('Optional skill selection artifact does not match the current preflight artifact hash.');
    }
    const hasExpectedTaskTextBinding = Object.prototype.hasOwnProperty.call(options, 'expectedTaskTextSha256');
    const expectedTaskTextSha256 = String(options.expectedTaskTextSha256 || '').trim();
    const actualTaskTextSha256 = String(payload.task_text_sha256 || '').trim();
    if (hasExpectedTaskTextBinding) {
        if (!expectedTaskTextSha256) {
            if (payload.task_text_present === true || actualTaskTextSha256) {
                violations.push('Optional skill selection artifact does not match the current task summary hash.');
            }
        } else if (actualTaskTextSha256 !== expectedTaskTextSha256) {
            violations.push('Optional skill selection artifact does not match the current task summary hash.');
        }
    }

    if (policyMode === 'off') {
        if (selectedSkills.length > 0) {
            violations.push("Policy mode 'off' must not include selected_installed_skills entries.");
        }
        if (recommendedMissingPacks.length > 0) {
            violations.push("Policy mode 'off' must not include recommended_missing_packs entries.");
        }
        if (decision !== 'as_is') {
            violations.push("Policy mode 'off' must emit decision 'as_is'.");
        }
        if (payload.as_is_reason !== 'policy_off') {
            violations.push("Policy mode 'off' must emit as_is_reason 'policy_off'.");
        }
        return violations;
    }

    if (selectedSkills.length > MAX_SELECTED_SKILLS) {
        violations.push(`Optional skill selection artifact exceeds the maximum selected_installed_skills count (${MAX_SELECTED_SKILLS}).`);
    }
    if (new Set(selectedSkillIds).size !== selectedSkillIds.length) {
        violations.push('Optional skill selection artifact must not contain duplicate selected_installed_skills entries.');
    }
    if (recommendedMissingPacks.length > MAX_RECOMMENDED_PACKS) {
        violations.push(`Optional skill selection artifact exceeds the maximum recommended_missing_packs count (${MAX_RECOMMENDED_PACKS}).`);
    }
    if (new Set(recommendedPackIds).size !== recommendedPackIds.length) {
        violations.push('Optional skill selection artifact must not contain duplicate recommended_missing_packs entries.');
    }

    if (decision === 'selected_installed_skills' && selectedSkills.length === 0) {
        violations.push("Decision 'selected_installed_skills' requires at least one selected skill.");
    }
    if (decision !== 'selected_installed_skills' && selectedSkills.length > 0) {
        violations.push(`Decision '${decision}' must not include selected_installed_skills entries.`);
    }
    if (decision === 'recommended_missing_packs' && recommendedMissingPacks.length === 0) {
        violations.push("Decision 'recommended_missing_packs' requires at least one recommended pack.");
    }
    if (decision !== 'recommended_missing_packs' && recommendedMissingPacks.length > 0) {
        violations.push(`Decision '${decision}' must not include recommended_missing_packs entries.`);
    }
    if (decision === 'as_is' && !payload.as_is_reason) {
        violations.push("Decision 'as_is' requires an explicit as_is_reason.");
    }
    if (policyMode === 'strict' && selectedSkills.length === 0 && !payload.as_is_reason) {
        violations.push("Policy mode 'strict' requires an explicit as_is_reason whenever no optional skill is selected.");
    }

    if (validateAgainstCurrentInventory) {
        for (const recommendedPack of recommendedMissingPacks) {
            const currentPack = currentOptionalPacksById.get(String(recommendedPack.id || '').trim());
            if (!currentPack) {
                violations.push(
                    `Recommended missing pack '${recommendedPack.id}' is not present in the current optional skill pack inventory.`
                );
                continue;
            }
            if (currentInstalledPackIds.has(currentPack.id)) {
                violations.push(
                    `Recommended missing pack '${recommendedPack.id}' is already installed in the current optional skill pack inventory.`
                );
            }
        }
    }

    for (const selectedSkill of selectedSkills) {
        const portablePath = String(selectedSkill.allowed_skill_path || '').trim();
        if (!portablePath) {
            violations.push(`Selected skill '${selectedSkill.id}' is missing allowed_skill_path.`);
            continue;
        }
        if (!validateAgainstCurrentInventory) {
            continue;
        }

        const resolvedPath = resolvePortableRepoPath(bundleRoot, portablePath);
        if (!pathExists(resolvedPath)) {
            violations.push(
                `Selected skill '${selectedSkill.id}' points to a missing skill reference path '${portablePath}'.`
            );
            continue;
        }

        const currentSkill = currentSelectableSkillsById.get(String(selectedSkill.id || '').trim());
        if (!currentSkill) {
            violations.push(
                `Selected skill '${selectedSkill.id}' is not present in the current installed optional skill inventory.`
            );
            continue;
        }

        const currentPack = currentSkill.pack || null;
        if ((selectedSkill.pack || null) !== currentPack) {
            violations.push(
                `Selected skill '${selectedSkill.id}' must keep its current pack binding '${currentPack || 'null'}'.`
            );
        }
        if (selectedSkill.source === 'installed_optional' && currentPack && !currentInstalledPackIds.has(currentPack)) {
            violations.push(
                `Selected skill '${selectedSkill.id}' belongs to optional pack '${currentPack}', which is not currently installed.`
            );
        }

        const expectedSkillPath = toPortableBundlePath(
            bundleRoot,
            path.join(bundleRoot, 'live', 'skills', String(currentSkill.directory || currentSkill.id || '').trim(), 'SKILL.md')
        );
        if (portablePath !== expectedSkillPath) {
            violations.push(
                `Selected skill '${selectedSkill.id}' must reference its canonical skill path '${expectedSkillPath}'.`
            );
        }
    }

    return violations;
}

export function getOptionalSkillSelectionGateViolations(
    bundleRoot: string,
    taskId: string,
    options: {
        expectedPreflightPath?: string | null;
        expectedPreflightSha256?: string | null;
        expectedTaskTextSha256?: string | null;
        taskEventsPath?: string | null;
        timelineEvidence?: OptionalSkillSelectionTimelineEvidence | null;
        loadedHeadlinesCache?: OptionalSkillSelectionArtifactData['loadedHeadlinesCache'];
    } = {}
): string[] {
    if (!isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
        return [];
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(bundleRoot);
    const requireMaterializedArtifact = policyConfig.mode === 'required' || policyConfig.mode === 'strict';
    const artifact = readOptionalSkillSelectionArtifact(bundleRoot, taskId);
    if (!artifact) {
        if (!requireMaterializedArtifact) {
            return [];
        }
        const expectedArtifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, taskId);
        return [
            `Optional skill selection artifact is missing for current task cycle: ${toPortableBundlePath(bundleRoot, expectedArtifactPath)}`
        ];
    }
    const validationOptions: Parameters<typeof getOptionalSkillSelectionArtifactViolations>[2] = {
        requireMaterializedArtifact,
        expectedPreflightPath: options.expectedPreflightPath || null,
        expectedPreflightSha256: options.expectedPreflightSha256 || null,
        expectedPolicyMode: policyConfig.mode,
        loadedHeadlinesCache: options.loadedHeadlinesCache || null
    };
    if (Object.prototype.hasOwnProperty.call(options, 'expectedTaskTextSha256')) {
        validationOptions.expectedTaskTextSha256 = options.expectedTaskTextSha256 ?? null;
    }
    const artifactViolations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, validationOptions);
    if (artifactViolations.length > 0 && requireMaterializedArtifact) {
        return artifactViolations;
    }

    const fallbackAsIsReason = policyConfig.mode === 'off'
        ? 'policy_off'
        : artifact.payload.as_is_reason || 'generic_context_sufficient';
    const enforcementPayload: OptionalSkillSelectionArtifact = artifactViolations.length === 0
        ? artifact.payload
        : {
            ...artifact.payload,
            policy_mode: policyConfig.mode,
            decision: 'as_is',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: fallbackAsIsReason,
            visible_summary_line: buildVisibleSummaryLine({
                decision: 'as_is',
                selectedInstalledSkills: [],
                recommendedMissingPacks: [],
                asIsReason: fallbackAsIsReason
            })
        };

    return collectOptionalSkillReferenceLoadViolations(
        bundleRoot,
        taskId,
        policyConfig.mode,
        enforcementPayload,
        options.taskEventsPath || null,
        options.timelineEvidence || null
    );
}

export function getOptionalSkillSelectionConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
}

export function isOptionalSkillSelectionPolicyConfigured(bundleRoot: string): boolean {
    return isManagedConfigMapped(bundleRoot, 'optional-skill-selection-policy');
}

export function getOptionalSkillSelectionArtifactPath(bundleRoot: string, taskId: string): string {
    return path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`);
}

export function readOptionalSkillSelectionPolicyConfig(bundleRoot: string): OptionalSkillSelectionPolicyConfig {
    const configPath = getOptionalSkillSelectionConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        if (isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
            throw new Error(
                `Managed optional skill selection policy config is missing: ${toPortableBundlePath(bundleRoot, configPath)}`
            );
        }
        return { ...DEFAULT_POLICY_CONFIG };
    }

    const validated = readValidatedConfig(configPath) as Record<string, unknown>;
    return {
        version: Number(validated.version || DEFAULT_POLICY_CONFIG.version),
        mode: String(validated.mode || DEFAULT_POLICY_CONFIG.mode) as OptionalSkillSelectionPolicyMode
    };
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

export function writeOptionalSkillSelectionArtifact(
    bundleRoot: string,
    taskId: string,
    options: WriteOptionalSkillSelectionOptions = {}
): OptionalSkillSelectionArtifactData {
    const builtArtifact = options.preparedArtifact || buildOptionalSkillSelectionArtifact(bundleRoot, taskId, options);
    const resolvedPreflightPath = options.preflightPath ? String(options.preflightPath).replace(/\\/g, '/') : null;
    const resolvedPreflightSha256 = typeof options.preflightSha256 === 'string'
        ? options.preflightSha256.trim() || null
        : computeFileSha256(options.preflightPath || null);
    const currentHeadlines = builtArtifact.payload.policy_mode === 'off'
        ? null
        : materializeCurrentHeadlinesSurface(
            bundleRoot,
            builtArtifact.loadedHeadlinesCache || options.loadedHeadlinesCache || null
        );
    const resolvedHeadlinesCache = currentHeadlines
        ? {
            headlinesPath: currentHeadlines.headlinesPath,
            headlinesSha256: currentHeadlines.headlinesSha256,
            materializationNeeded: false,
            skills: Array.isArray(currentHeadlines.payload.skills) ? currentHeadlines.payload.skills : [],
            optional_packs: Array.isArray(currentHeadlines.payload.optional_packs) ? currentHeadlines.payload.optional_packs : [],
            payload: currentHeadlines.payload
        }
        : null;
    const resolvedHeadlinesPath = currentHeadlines?.headlinesPath || getSkillsHeadlinesConfigPath(bundleRoot);
    const resolvedHeadlinesSha256 = currentHeadlines?.headlinesSha256 || computeFileSha256(resolvedHeadlinesPath);
    const artifact: OptionalSkillSelectionArtifactData = {
        artifactPath: getOptionalSkillSelectionArtifactPath(bundleRoot, taskId),
        payload: {
            ...builtArtifact.payload,
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            task_text_present: typeof options.taskText === 'string'
                ? options.taskText.trim().length > 0
                : builtArtifact.payload.task_text_present,
            task_text_sha256: typeof options.taskText === 'string'
                ? computeOptionalSkillTaskTextSha256(options.taskText)
                : builtArtifact.payload.task_text_sha256,
            changed_paths: Array.isArray(options.changedPaths)
                ? uniqueSorted(options.changedPaths.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean))
                : builtArtifact.payload.changed_paths,
            preflight_path: resolvedPreflightPath,
            preflight_sha256: resolvedPreflightSha256,
            headlines_path: toPortableBundlePath(bundleRoot, resolvedHeadlinesPath),
            headlines_sha256: resolvedHeadlinesSha256
        },
        loadedHeadlinesCache: resolvedHeadlinesCache
    };
    ensureDirectory(path.dirname(artifact.artifactPath));
    writeJsonFile(artifact.artifactPath, artifact.payload);
    const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
        requireMaterializedArtifact: true,
        expectedPreflightPath: options.preflightPath || null,
        expectedPreflightSha256: options.preflightSha256 || null,
        expectedPolicyMode: readOptionalSkillSelectionPolicyConfig(bundleRoot).mode,
        loadedHeadlinesCache: artifact.loadedHeadlinesCache || null
    });
    if (violations.length > 0) {
        fs.rmSync(artifact.artifactPath, { force: true });
        throw new Error(violations.join(' '));
    }
    return artifact;
}

export function readOptionalSkillSelectionArtifact(
    bundleRoot: string,
    taskId: string
): OptionalSkillSelectionArtifactData | null {
    const artifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, taskId);
    if (!pathExists(artifactPath)) {
        return null;
    }
    try {
        return {
            artifactPath,
            payload: readJsonFile(artifactPath) as OptionalSkillSelectionArtifact
        };
    } catch {
        return null;
    }
}
