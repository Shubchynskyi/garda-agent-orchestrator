import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists, readTextFile } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';
import { getProjectDiscovery } from '../materialization/project-discovery';
import { emitSkillSuggestedEvent } from './skill-telemetry';

type JsonObject = Record<string, unknown>;

const REVIEW_CAPABILITY_KEYS = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

const OPTIONAL_REVIEW_CAPABILITY_KEYS = Object.freeze([
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

type ReviewCapabilityKey = (typeof REVIEW_CAPABILITY_KEYS)[number];
type OptionalReviewCapabilityKey = (typeof OPTIONAL_REVIEW_CAPABILITY_KEYS)[number];
type ReviewCapabilities = Record<ReviewCapabilityKey, boolean>;
type SignalMatchCategory =
    | 'stack_signals'
    | 'task_signals'
    | 'changed_path_signals'
    | 'project_path_signals'
    | 'aliases_or_tags';

interface InstalledSkillPacksPayload {
    version: number;
    installed_packs: string[];
}

interface SkillPackManifestDefinition {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommendedFor: string[];
    packRoot: string;
}

interface SkillManifestDefinition {
    id: string;
    name: string;
    pack: string;
    summary: string;
    tags: string[];
    aliases: string[];
    stackSignals: string[];
    taskSignals: string[];
    changedPathSignals: string[];
    references: string[];
    costHint: string;
    priority: number;
    autoload: string;
    deprecated: boolean;
    replacedBy: string | null;
    implemented: boolean;
    skillRoot: string;
}

interface BaselineSkillManifestDefinition {
    id: string;
    name: string;
    summary: string;
    tags: string[];
    aliases: string[];
    references: string[];
    costHint: string;
    priority: number;
    autoload: string;
    skillRoot: string;
}

interface ManifestWithReferences {
    references: string[];
}

interface BuiltinSkillPackDefinition extends SkillPackManifestDefinition {
    skills: SkillManifestDefinition[];
    skillCount: number;
    skillDirectories: string[];
    readySkillCount: number;
    readySkillDirectories: string[];
    placeholderSkillCount: number;
    placeholderSkillDirectories: string[];
    implemented: boolean;
    collidesWithBaseline: boolean;
}

interface SkillsIndexPackEntry {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommended_for: string[];
    skill_count: number;
    ready_skill_count: number;
    placeholder_skill_count: number;
    implemented: boolean;
    collides_with_baseline: boolean;
}

interface SkillsIndexSkillEntry {
    id: string;
    name: string;
    pack: string;
    summary: string;
    tags: string[];
    aliases: string[];
    stack_signals: string[];
    task_signals: string[];
    changed_path_signals: string[];
    references: string[];
    cost_hint: string;
    priority: number;
    autoload: string;
    deprecated: boolean;
    replaced_by: string | null;
    implemented: boolean;
    template_skill_path: string;
}

interface SkillsIndexPayload {
    version: number;
    packs: SkillsIndexPackEntry[];
    skills: SkillsIndexSkillEntry[];
}

interface SkillsIndexData {
    indexPath: string;
    payload: SkillsIndexPayload;
}

export interface SignalMatches {
    stack_signals: string[];
    task_signals: string[];
    changed_path_signals: string[];
    project_path_signals: string[];
    aliases_or_tags: string[];
}

interface ProjectDiscoveryData {
    source: string;
    detectedStacks: string[];
    topLevelDirectories: string[];
    relativeFiles: string[];
}

interface SuggestionContext {
    discovery: ProjectDiscoveryData;
    taskText: string;
    taskTextLower: string;
    projectPaths: string[];
    changedPaths: string[];
    textCorpus: string;
    textCorpusLower: string;
}

export interface SkillSuggestion {
    id: string;
    name: string;
    pack: string;
    summary: string;
    score: number;
    installed: boolean;
    matches: SignalMatches;
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

interface ReadInstalledSkillPacksResult {
    configPath: string;
    installedPackIds: string[];
}

interface ListedBuiltinPack {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommendedFor: string[];
    skillCount: number;
    readySkillCount: number;
    readySkillDirectories: string[];
    placeholderSkillCount: number;
    placeholderSkillDirectories: string[];
    implemented: boolean;
    collidesWithBaseline: boolean;
    skillDirectories: string[];
    installed: boolean;
}

interface SkillPackListing {
    configPath: string;
    indexPath: string;
    baselineSkillDirectories: string[];
    liveSkillDirectories: string[];
    installedPackIds: string[];
    installedOptionalSkillDirectories: string[];
    builtinPacks: ListedBuiltinPack[];
    customSkillDirectories: string[];
}

type FuzzyAliasMap = Map<string, string[]>;

function asObjectRecord(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : {};
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

export const BASELINE_SKILL_DIRECTORIES = Object.freeze([
    'code-review',
    'db-review',
    'dependency-review',
    'orchestration',
    'orchestration-depth1',
    'refactor-review',
    'security-review',
    'skill-builder'
]);

const DEFAULT_INSTALLED_PACKS_PAYLOAD: Readonly<InstalledSkillPacksPayload> = Object.freeze({
    version: 1,
    installed_packs: []
});

const REVIEW_CAPABILITIES_DEFAULTS: Readonly<ReviewCapabilities> = Object.freeze({
    code: true,
    db: true,
    security: true,
    refactor: true,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

const OPTIONAL_REVIEW_SKILL_DIRECTORY_MAP: Readonly<Record<OptionalReviewCapabilityKey, readonly string[]>> = Object.freeze({
    api: ['api-review', 'api-contract-review'],
    test: ['test-review', 'testing-strategy'],
    performance: ['performance-review'],
    infra: ['infra-review', 'devops-k8s'],
    dependency: ['dependency-review']
});

export const SKILLS_INDEX_VERSION = 1;
const OPTIONAL_SKILL_PLACEHOLDER_PATTERN = /TODO:\s*fill this optional skill\.?/i;
const SUGGESTED_SKILL_MIN_SCORE = 75;
const SUGGESTED_PACK_MIN_SCORE = 75;

function normalizeStringArray(value: unknown): string[] {
    const items: unknown[] = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    const normalized: string[] = [];
    for (const item of items) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }
    return normalized.sort();
}

function normalizeOptionalString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
    const text = normalizeOptionalString(value);
    if (!text) {
        throw new Error(`${fieldName} is required.`);
    }
    return text;
}

function normalizeNonNegativeInteger(value: unknown, fallbackValue: number): number {
    if (value === undefined || value === null || value === '') {
        return fallbackValue;
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0) {
        throw new Error(`Expected a non-negative integer, got '${value}'.`);
    }
    return numeric;
}

export function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

export function getSkillsIndexConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skills-index.json');
}

export function getReviewCapabilitiesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'review-capabilities.json');
}

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

function getTemplateSkillPacksRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'skill-packs');
}

function getPackTemplateRoot(bundleRoot: string, packId: string): string {
    return path.join(getTemplateSkillPacksRoot(bundleRoot), packId);
}

function getPackManifestPath(packRoot: string): string {
    return path.join(packRoot, 'pack.json');
}

function getSkillManifestPath(skillRoot: string): string {
    return path.join(skillRoot, 'skill.json');
}

function getTemplateSkillRelativePath(packId: string, skillId: string): string {
    return path.join('template', 'skill-packs', packId, 'skills', skillId, 'SKILL.md').replace(/\\/g, '/');
}

function isPlaceholderOptionalSkill(summary: unknown, skillRoot: string): boolean {
    if (OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(String(summary || ''))) {
        return true;
    }

    const skillPath = path.join(skillRoot, 'SKILL.md');
    if (!pathExists(skillPath)) {
        return false;
    }

    try {
        return OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(readTextFile(skillPath));
    } catch {
        return false;
    }
}

function readPackManifest(packRoot: string): SkillPackManifestDefinition {
    const manifestPath = getPackManifestPath(packRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill pack manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackPackId = path.basename(packRoot);

    return {
        id: normalizeRequiredString(manifest.id || fallbackPackId, `pack.json id (${fallbackPackId})`),
        label: normalizeRequiredString(manifest.label || fallbackPackId, `pack.json label (${fallbackPackId})`),
        description: normalizeRequiredString(manifest.description, `pack.json description (${fallbackPackId})`),
        tags: normalizeStringArray(manifest.tags),
        recommendedFor: normalizeStringArray(manifest.recommended_for),
        packRoot
    };
}

function readSkillManifest(skillRoot: string, fallbackPackId: string): SkillManifestDefinition {
    const manifestPath = getSkillManifestPath(skillRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackSkillId = path.basename(skillRoot);
    const skillId = normalizeRequiredString(manifest.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`);
    const packId = normalizeRequiredString(manifest.pack || fallbackPackId, `skill.json pack (${skillId})`);

    return {
        id: skillId,
        name: normalizeRequiredString(manifest.name || skillId, `skill.json name (${skillId})`),
        pack: packId,
        summary: normalizeRequiredString(manifest.summary, `skill.json summary (${skillId})`),
        tags: normalizeStringArray(manifest.tags),
        aliases: normalizeStringArray(manifest.aliases),
        stackSignals: normalizeStringArray(manifest.stack_signals),
        taskSignals: normalizeStringArray(manifest.task_signals),
        changedPathSignals: normalizeStringArray(manifest.changed_path_signals),
        references: normalizeStringArray(manifest.references),
        costHint: normalizeRequiredString(manifest.cost_hint || 'low', `skill.json cost_hint (${skillId})`),
        priority: normalizeNonNegativeInteger(manifest.priority, 50),
        autoload: normalizeRequiredString(manifest.autoload || 'never', `skill.json autoload (${skillId})`),
        deprecated: manifest.deprecated === true,
        replacedBy: normalizeOptionalString(manifest.replaced_by),
        implemented: !isPlaceholderOptionalSkill(manifest.summary, skillRoot),
        skillRoot
    };
}

function readBaselineSkillManifest(skillRoot: string): BaselineSkillManifestDefinition {
    const manifestPath = getSkillManifestPath(skillRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackSkillId = path.basename(skillRoot);

    return {
        id: normalizeRequiredString(manifest.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`),
        name: normalizeRequiredString(manifest.name || fallbackSkillId, `skill.json name (${fallbackSkillId})`),
        summary: normalizeRequiredString(manifest.summary, `skill.json summary (${fallbackSkillId})`),
        tags: normalizeStringArray(manifest.tags),
        aliases: normalizeStringArray(manifest.aliases),
        references: normalizeStringArray(manifest.references),
        costHint: normalizeRequiredString(manifest.cost_hint || 'low', `skill.json cost_hint (${fallbackSkillId})`),
        priority: normalizeNonNegativeInteger(manifest.priority, 50),
        autoload: normalizeRequiredString(manifest.autoload || 'never', `skill.json autoload (${fallbackSkillId})`),
        skillRoot
    };
}

function collectMissingReferenceIssues(skillRoot: string, manifest: ManifestWithReferences, skillLabel: string): string[] {
    const issues: string[] = [];
    for (const reference of manifest.references) {
        const referencePath = path.join(skillRoot, 'references', reference);
        if (!pathExists(referencePath)) {
            issues.push(`${skillLabel} declares missing reference '${reference}'.`);
        }
    }
    return issues;
}

function listPackSkillDefinitions(packRoot: string, packId: string): SkillManifestDefinition[] {
    const skillsRoot = path.join(packRoot, 'skills');
    if (!pathExists(skillsRoot)) {
        return [];
    }

    return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSkillManifest(path.join(skillsRoot, entry.name), packId))
        .sort((left, right) => left.id.localeCompare(right.id));
}

export function listBuiltinSkillPacks(bundleRoot: string): BuiltinSkillPackDefinition[] {
    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (!pathExists(templateSkillPacksRoot)) {
        return [];
    }

    return fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const packRoot = path.join(templateSkillPacksRoot, entry.name);
            const manifest = readPackManifest(packRoot);
            const skills = listPackSkillDefinitions(packRoot, manifest.id);
            const readySkills = skills.filter((skill) => skill.implemented !== false);
            const placeholderSkills = skills.filter((skill) => skill.implemented === false);
            return {
                ...manifest,
                skills,
                skillCount: skills.length,
                skillDirectories: skills.map((skill) => skill.id),
                readySkillCount: readySkills.length,
                readySkillDirectories: readySkills.map((skill) => skill.id),
                placeholderSkillCount: placeholderSkills.length,
                placeholderSkillDirectories: placeholderSkills.map((skill) => skill.id),
                implemented: readySkills.length > 0,
                collidesWithBaseline: BASELINE_SKILL_DIRECTORIES.includes(manifest.id)
            };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
}

export function getBuiltinSkillPackDefinition(bundleRoot: string, packId: string): BuiltinSkillPackDefinition | null {
    return listBuiltinSkillPacks(bundleRoot).find((pack) => pack.id === packId) || null;
}

export function buildSkillsIndex(bundleRoot: string): SkillsIndexPayload {
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    return {
        version: SKILLS_INDEX_VERSION,
        packs: builtinPacks.map((pack) => ({
            id: pack.id,
            label: pack.label,
            description: pack.description,
            tags: pack.tags,
            recommended_for: pack.recommendedFor,
            skill_count: pack.skillCount,
            ready_skill_count: pack.readySkillCount,
            placeholder_skill_count: pack.placeholderSkillCount,
            implemented: pack.implemented,
            collides_with_baseline: pack.collidesWithBaseline
        })),
        skills: builtinPacks
            .flatMap((pack) => pack.skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                pack: skill.pack,
                summary: skill.summary,
                tags: skill.tags,
                aliases: skill.aliases,
                stack_signals: skill.stackSignals,
                task_signals: skill.taskSignals,
                changed_path_signals: skill.changedPathSignals,
                references: skill.references,
                cost_hint: skill.costHint,
                priority: skill.priority,
                autoload: skill.autoload,
                deprecated: skill.deprecated,
                replaced_by: skill.replacedBy,
                implemented: skill.implemented !== false,
                template_skill_path: getTemplateSkillRelativePath(pack.id, skill.id)
            })))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

export function writeSkillsIndex(bundleRoot: string): string {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    ensureDirectory(path.dirname(indexPath));
    writeJsonFile(indexPath, buildSkillsIndex(bundleRoot));
    return indexPath;
}

export function readSkillsIndex(bundleRoot: string): SkillsIndexData {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    if (!pathExists(indexPath)) {
        throw new Error(`Skills index is missing: ${indexPath}`);
    }

    const payload = asObjectRecord(readJsonFile(indexPath));
    if (!payload || !Array.isArray(payload.packs) || !Array.isArray(payload.skills)) {
        throw new Error(`Skills index has an invalid shape: ${indexPath}`);
    }

    return {
        indexPath,
        payload: payload as unknown as SkillsIndexPayload
    };
}

function normalizeReviewCapabilitiesConfig(raw: unknown): ReviewCapabilities {
    const normalized = {} as ReviewCapabilities;
    const source = asObjectRecord(raw);

    for (const key of REVIEW_CAPABILITY_KEYS) {
        normalized[key] = key in source ? Boolean(source[key]) : REVIEW_CAPABILITIES_DEFAULTS[key];
    }

    return normalized;
}

function readTemplateReviewCapabilities(bundleRoot: string): ReviewCapabilities {
    const templatePath = path.join(bundleRoot, 'template', 'config', 'review-capabilities.json');
    if (!pathExists(templatePath)) {
        return { ...REVIEW_CAPABILITIES_DEFAULTS };
    }

    try {
        return normalizeReviewCapabilitiesConfig(readJsonFile(templatePath));
    } catch {
        return { ...REVIEW_CAPABILITIES_DEFAULTS };
    }
}

// ---------------------------------------------------------------------------
// Fuzzy alias expansion – deterministic, reviewable synonym groups for
// abbreviation ↔ full-name matching (T-078).
// Each inner array is a group of equivalent terms.  Matching is symmetric:
// if signal says "kubernetes" and text says "k8s" (or vice-versa), the
// alias layer bridges the gap.  All terms are compared lowercased.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------

function normalizeSearchText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeSearchTokens(value: unknown): string[] {
    return normalizeSearchText(value)
        .split(/[^a-z0-9.+#/_-]+/i)
        .map((item) => item.trim())
        .filter(Boolean);
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

function buildSuggestionContext(targetRoot: string, taskText: unknown, changedPaths: unknown): SuggestionContext {
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

function scoreSkillSuggestion(
    skill: SkillsIndexSkillEntry,
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
        installed: installedPackIds.includes(skill.pack),
        matches: {
            stack_signals: stackMatches,
            task_signals: taskMatches,
            changed_path_signals: changedPathMatches,
            project_path_signals: projectPathMatches,
            aliases_or_tags: aliasMatches
        }
    };
}

// ---------------------------------------------------------------------------
// Same-pack dedupe – keeps the top-N suggestion list diverse across packs
// (T-080).  The strongest skill per pack is always preserved.  Additional
// same-pack skills survive only when they contribute evidence in a signal
// category the primary skill does not cover.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------

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
    const listing = listSkillPacks(bundleRoot);
    const liveSkillDirectorySet = new Set(listing.liveSkillDirectories);
    const context = buildSuggestionContext(targetRoot, options.taskText || '', options.changedPaths || []);
    const packIndex = new Map<string, SkillsIndexPackEntry>(payload.packs.map((pack: SkillsIndexPackEntry) => [pack.id, pack]));
    const limit = normalizeNonNegativeInteger(options.limit, 7) || 7;
    const packLimit = normalizeNonNegativeInteger(options.packLimit, 5) || 5;

    const allSkillSuggestions = payload.skills
        .filter((skill: SkillsIndexSkillEntry) => skill.implemented !== false)
        .map((skill: SkillsIndexSkillEntry) => scoreSkillSuggestion(skill, context, installedPackIds))
        .filter((skill): skill is SkillSuggestion => skill !== null)
        .sort((left: SkillSuggestion, right: SkillSuggestion) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.id.localeCompare(right.id);
        });

    const availableRelevantSkillsFull = allSkillSuggestions.filter((skill: SkillSuggestion) => liveSkillDirectorySet.has(skill.id));
    const suggestedSkillsFull = allSkillSuggestions.filter((skill: SkillSuggestion) => (
        !liveSkillDirectorySet.has(skill.id) &&
        skill.score >= SUGGESTED_SKILL_MIN_SCORE
    ));

    // Pack aggregation uses the full (non-deduped) skill lists so pack
    // scores and match summaries remain comprehensive.
    const availableRelevantPacks = aggregatePackSuggestions(availableRelevantSkillsFull, packIndex, installedPackIds);
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

function validateInstalledPackIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: string[] = [];
    for (const item of value) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }

    return normalized.sort();
}

export function readInstalledSkillPacks(bundleRoot: string): ReadInstalledSkillPacksResult {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        return {
            configPath,
            installedPackIds: []
        };
    }

    const payload = asObjectRecord(readJsonFile(configPath));
    return {
        configPath,
        installedPackIds: validateInstalledPackIds(payload.installed_packs)
    };
}

export function writeInstalledSkillPacks(bundleRoot: string, installedPackIds: unknown): string {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    writeJsonFile(configPath, {
        ...DEFAULT_INSTALLED_PACKS_PAYLOAD,
        installed_packs: validateInstalledPackIds(installedPackIds)
    });
    return configPath;
}

function listLiveSkillDirectories(bundleRoot: string): string[] {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (!pathExists(liveSkillsRoot)) {
        return [];
    }

    return fs.readdirSync(liveSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

export function syncReviewCapabilities(bundleRoot: string): { configPath: string; capabilities: ReviewCapabilities } {
    const configPath = getReviewCapabilitiesConfigPath(bundleRoot);
    const capabilities = readTemplateReviewCapabilities(bundleRoot);
    const liveSkillDirectorySet = new Set(listLiveSkillDirectories(bundleRoot));

    for (const capabilityKey of OPTIONAL_REVIEW_CAPABILITY_KEYS) {
        const candidateDirectories = OPTIONAL_REVIEW_SKILL_DIRECTORY_MAP[capabilityKey];
        capabilities[capabilityKey] = candidateDirectories.some((candidate: string) => liveSkillDirectorySet.has(candidate));
    }

    ensureDirectory(path.dirname(configPath));
    writeJsonFile(configPath, capabilities);

    return {
        configPath,
        capabilities
    };
}

export function listSkillPacks(bundleRoot: string): SkillPackListing {
    const installed = readInstalledSkillPacks(bundleRoot);
    const liveSkillDirectories = listLiveSkillDirectories(bundleRoot);
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const managedPackSkillDirs = new Set<string>();

    for (const packId of installed.installedPackIds) {
        const pack = builtinPacks.find((candidate) => candidate.id === packId);
        if (!pack) {
            continue;
        }
        for (const skillDir of pack.skillDirectories) {
            managedPackSkillDirs.add(skillDir);
        }
    }

    const customSkillDirectories = liveSkillDirectories.filter((skillDir: string) => {
        return !BASELINE_SKILL_DIRECTORIES.includes(skillDir) && !managedPackSkillDirs.has(skillDir);
    });
    const installedOptionalSkillDirectories = liveSkillDirectories.filter((skillDir: string) => managedPackSkillDirs.has(skillDir));

    return {
        configPath: installed.configPath,
        indexPath: getSkillsIndexConfigPath(bundleRoot),
        baselineSkillDirectories: [...BASELINE_SKILL_DIRECTORIES],
        liveSkillDirectories,
        installedPackIds: installed.installedPackIds,
        installedOptionalSkillDirectories,
        builtinPacks: builtinPacks.map((pack) => ({
            id: pack.id,
            label: pack.label,
            description: pack.description,
            tags: pack.tags,
            recommendedFor: pack.recommendedFor,
            skillCount: pack.skillCount,
            readySkillCount: pack.readySkillCount,
            readySkillDirectories: [...pack.readySkillDirectories],
            placeholderSkillCount: pack.placeholderSkillCount,
            placeholderSkillDirectories: [...pack.placeholderSkillDirectories],
            implemented: pack.implemented,
            collidesWithBaseline: pack.collidesWithBaseline,
            skillDirectories: [...pack.skillDirectories],
            installed: installed.installedPackIds.includes(pack.id)
        })),
        customSkillDirectories
    };
}

function copyDirectoryRecursive(sourcePath: string, destinationPath: string): void {
    ensureDirectory(destinationPath);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourceEntryPath, destinationEntryPath);
        } else {
            ensureDirectory(path.dirname(destinationEntryPath));
            fs.copyFileSync(sourceEntryPath, destinationEntryPath);
        }
    }
}

export function addSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const templateRoot = getPackTemplateRoot(bundleRoot, packId);
    if (!pathExists(templateRoot)) {
        throw new Error(`Skill pack template is missing: ${templateRoot}`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            installedPackIds: current.installedPackIds,
            installedSkillDirectories: [...pack.skillDirectories],
            configPath: current.configPath
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    ensureDirectory(liveSkillsRoot);

    for (const skillDir of pack.skillDirectories) {
        const sourceSkillDir = path.join(templateRoot, 'skills', skillDir);
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (!pathExists(sourceSkillDir)) {
            throw new Error(`Skill pack asset is missing: ${sourceSkillDir}`);
        }
        if (pathExists(destinationSkillDir)) {
            throw new Error(`Cannot install skill pack '${packId}' because '${destinationSkillDir}' already exists.`);
        }
        copyDirectoryRecursive(sourceSkillDir, destinationSkillDir);
    }

    const updatedPackIds = [...current.installedPackIds, packId].sort();
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);

    return {
        packId,
        changed: true,
        installedPackIds: updatedPackIds,
        installedSkillDirectories: [...pack.skillDirectories],
        configPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

export function removeSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (!current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            removedSkillDirectories: [],
            installedPackIds: current.installedPackIds,
            configPath: current.configPath
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const removedSkillDirectories: string[] = [];
    for (const skillDir of pack.skillDirectories) {
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (pathExists(destinationSkillDir)) {
            fs.rmSync(destinationSkillDir, { recursive: true, force: true });
            removedSkillDirectories.push(skillDir);
        }
    }

    const updatedPackIds = current.installedPackIds.filter((candidate: string) => candidate !== packId);
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);

    return {
        packId,
        changed: true,
        removedSkillDirectories,
        installedPackIds: updatedPackIds,
        configPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

export function validateSkillsIndex(bundleRoot: string) {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    const issues: string[] = [];
    const expected = buildSkillsIndex(bundleRoot);

    if (!pathExists(indexPath)) {
        issues.push(`Skills index is missing: ${indexPath}`);
        return { indexPath, expected, issues, passed: false };
    }

    let parsed: unknown = null;
    try {
        parsed = readJsonFile(indexPath);
    } catch {
        issues.push(`Skills index is not valid JSON: ${indexPath}`);
        return { indexPath, expected, issues, passed: false };
    }

    const actualSerialized = JSON.stringify(parsed);
    const expectedSerialized = JSON.stringify(expected);
    if (actualSerialized !== expectedSerialized) {
        issues.push(`Skills index is stale: ${indexPath}. Re-run init/materialization to refresh it.`);
    }

    return {
        indexPath,
        expected,
        issues,
        passed: issues.length === 0
    };
}

export function validateSkillPacks(bundleRoot: string) {
    const listing = listSkillPacks(bundleRoot);
    const issues: string[] = [];
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const liveSkillsReadmePath = path.join(liveSkillsRoot, 'README.md');

    if (!pathExists(liveSkillsReadmePath)) {
        issues.push(`Live skills README is missing: ${liveSkillsReadmePath}`);
    }

    for (const skillDir of BASELINE_SKILL_DIRECTORIES) {
        const skillRoot = path.join(liveSkillsRoot, skillDir);
        const skillPath = path.join(skillRoot, 'SKILL.md');
        const skillManifestPath = path.join(skillRoot, 'skill.json');

        if (!pathExists(skillRoot)) {
            issues.push(`Baseline skill directory is missing: ${skillRoot}`);
            continue;
        }

        if (!pathExists(skillManifestPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/skill.json'.`);
        } else {
            try {
                const manifest = readBaselineSkillManifest(skillRoot);
                if (manifest.id !== skillDir) {
                    issues.push(`Baseline skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                }
                issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Baseline skill '${skillDir}'`));
            } catch (error) {
                issues.push(`Baseline skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
            }
        }

        if (!pathExists(skillPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/SKILL.md'.`);
        }
    }

    for (const pack of listing.builtinPacks) {
        if (pack.collidesWithBaseline) {
            issues.push(`Optional skill pack '${pack.id}' collides with baseline skill id '${pack.id}'. Optional packs must not duplicate baseline skills.`);
        }
        for (const skillDir of pack.skillDirectories) {
            if (BASELINE_SKILL_DIRECTORIES.includes(skillDir)) {
                issues.push(`Optional skill pack '${pack.id}' includes skill directory '${skillDir}' that duplicates a baseline skill.`);
            }
        }
    }

    for (const packId of listing.installedPackIds) {
        const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
        if (!pack) {
            issues.push(`Installed skill pack '${packId}' is not a known built-in pack.`);
            continue;
        }

        for (const skillDir of pack.skillDirectories) {
            const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillDir);
            const skillPath = path.join(skillRoot, 'SKILL.md');
            const skillManifestPath = path.join(skillRoot, 'skill.json');

            if (!pathExists(skillRoot)) {
                issues.push(`Installed skill pack '${packId}' is missing live skill directory '${skillDir}'.`);
                continue;
            }

            if (!pathExists(skillManifestPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/skill.json'.`);
            } else {
                try {
                    const manifest = readSkillManifest(skillRoot, packId);
                    if (manifest.id !== skillDir) {
                        issues.push(`Installed skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                    }
                    if (manifest.pack !== packId) {
                        issues.push(`Installed skill '${skillDir}' declares pack '${manifest.pack}' instead of '${packId}'.`);
                    }
                    issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Installed skill '${skillDir}'`));
                } catch (error) {
                    issues.push(`Installed skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
                }
            }

            if (!pathExists(skillPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/SKILL.md'.`);
            }
        }
    }

    const skillsIndexValidation = validateSkillsIndex(bundleRoot);
    issues.push(...skillsIndexValidation.issues);

    return {
        ...listing,
        issues,
        passed: issues.length === 0
    };
}
