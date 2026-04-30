import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDirectory, pathExists } from '../core/filesystem';
import { formatJson, readJsonFile, writeJsonFile } from '../core/json';
import {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    listBuiltinSkillPacks,
    normalizeNonNegativeInteger,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeStringArray,
    readBaselineSkillManifest,
    readSkillManifest,
    type BaselineSkillManifestDefinition,
    type BuiltinSkillPackDefinition,
    type SkillManifestDefinition,
    type SkillPackManifestDefinition
} from './skill-manifest';

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

interface CurrentSkillsHeadlinesState {
    headlinesPath: string;
    snapshots: SkillsHeadlinesSourceFileSnapshot[];
    installedPackIds: string[];
    installedOptionalSkillIds: string[];
    customSkillIds: string[];
    skills: SkillsHeadlineSkillEntry[];
    optionalPacks: SkillsHeadlinePackEntry[];
}

export const SKILLS_HEADLINES_VERSION = 2;

const REVIEW_BOUND_SPECIAL_CASE_IDS = new Set<string>([
    'devops-k8s',
    'testing-strategy'
]);
const OPTIONAL_SKILL_PLACEHOLDER_PATTERN = /TODO:\s*fill this optional skill\.?/i;

interface SkillsHeadlinesSourceFileSnapshot {
    filePath: string;
    relativePath: string;
    stats: fs.Stats;
    text: string;
    parsed: Record<string, unknown>;
}

function computeSha256FromText(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function computePayloadSha256(payload: SkillsHeadlinesPayload): string {
    return computeSha256FromText(formatJson(payload));
}

export function computeSkillsHeadlinesSelectionSurfaceSha256(payload: Pick<
    SkillsHeadlinesPayload,
    'installed_pack_ids' | 'baseline_skill_ids' | 'installed_optional_skill_ids' | 'custom_skill_ids' | 'skills' | 'optional_packs'
>): string {
    return computeSha256FromText(formatJson({
        installed_pack_ids: payload.installed_pack_ids,
        baseline_skill_ids: payload.baseline_skill_ids,
        installed_optional_skill_ids: payload.installed_optional_skill_ids,
        custom_skill_ids: payload.custom_skill_ids,
        skills: payload.skills,
        optional_packs: payload.optional_packs
    }));
}

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

function isValidSkillsHeadlinesPayload(value: Record<string, unknown>): boolean {
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

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

function getTemplateSkillPacksRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'skill-packs');
}

function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

function sortDirectoryEntries(entries: fs.Dirent[]): fs.Dirent[] {
    return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function readJsonSourceFileSnapshot(bundleRoot: string, filePath: string): SkillsHeadlinesSourceFileSnapshot {
    const text = fs.readFileSync(filePath, 'utf8');
    return {
        filePath,
        relativePath: path.relative(path.resolve(bundleRoot), filePath).replace(/\\/g, '/'),
        stats: fs.statSync(filePath),
        text,
        parsed: asObjectRecord(JSON.parse(text))
    };
}

function computeSourceStateSha256FromSnapshots(snapshots: readonly SkillsHeadlinesSourceFileSnapshot[]): string {
    const hash = createHash('sha256');
    for (const snapshot of snapshots) {
        hash.update(snapshot.relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(snapshot.text, 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

function computeSourceStateHintSha256FromSnapshots(snapshots: readonly SkillsHeadlinesSourceFileSnapshot[]): string {
    const hash = createHash('sha256');
    for (const snapshot of snapshots) {
        hash.update(snapshot.relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(computeSha256FromText(snapshot.text), 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
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
        return OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(fs.readFileSync(skillPath, 'utf8'));
    } catch {
        return false;
    }
}

function parsePackManifestSnapshot(snapshot: SkillsHeadlinesSourceFileSnapshot): SkillPackManifestDefinition {
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

function parseSkillManifestSnapshot(
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

function parseBaselineSkillManifestSnapshot(snapshot: SkillsHeadlinesSourceFileSnapshot): BaselineSkillManifestDefinition {
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

function collectHeadlineSourceStateFiles(bundleRoot: string): string[] {
    const files: string[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    if (pathExists(skillPacksConfigPath)) {
        files.push(skillPacksConfigPath);
    }

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (pathExists(templateSkillPacksRoot)) {
        for (const entry of fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const packRoot = path.join(templateSkillPacksRoot, entry.name);
            const packManifestPath = path.join(packRoot, 'pack.json');
            if (pathExists(packManifestPath)) {
                files.push(packManifestPath);
            }
            const skillsRoot = path.join(packRoot, 'skills');
            if (!pathExists(skillsRoot)) {
                continue;
            }
            for (const skillEntry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
                if (!skillEntry.isDirectory()) {
                    continue;
                }
                const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                if (pathExists(skillManifestPath)) {
                    files.push(skillManifestPath);
                }
            }
        }
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (pathExists(liveSkillsRoot)) {
        for (const skillEntry of fs.readdirSync(liveSkillsRoot, { withFileTypes: true })) {
            if (!skillEntry.isDirectory()) {
                continue;
            }
            const skillManifestPath = path.join(liveSkillsRoot, skillEntry.name, 'skill.json');
            if (pathExists(skillManifestPath)) {
                files.push(skillManifestPath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

export function computeSkillsHeadlinesSourceStateSha256(bundleRoot: string): string {
    const hash = createHash('sha256');
    const normalizedBundleRoot = path.resolve(bundleRoot);
    for (const filePath of collectHeadlineSourceStateFiles(bundleRoot)) {
        const relativePath = path.relative(normalizedBundleRoot, filePath).replace(/\\/g, '/');
        hash.update(relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(fs.readFileSync(filePath));
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

export function computeSkillsHeadlinesSourceStateHintSha256(bundleRoot: string): string {
    const hash = createHash('sha256');
    const normalizedBundleRoot = path.resolve(bundleRoot);
    for (const filePath of collectHeadlineSourceStateFiles(bundleRoot)) {
        const relativePath = path.relative(normalizedBundleRoot, filePath).replace(/\\/g, '/');
        hash.update(relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

function normalizeInstalledPackIds(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [];
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

function readInstalledPackIds(bundleRoot: string): string[] {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        return [];
    }

    try {
        const payload = asObjectRecord(readJsonFile(configPath));
        return normalizeInstalledPackIds(payload.installed_packs);
    } catch {
        return [];
    }
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

function getReviewBinding(skill: {
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

function toOptionalPackEntry(
    pack: ReturnType<typeof listBuiltinSkillPacks>[number],
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

function tryBuildBaselineSkillEntry(bundleRoot: string, skillDirectory: string): SkillsHeadlineSkillEntry | null {
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

function tryBuildLiveSkillEntry(
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

export function getSkillsHeadlinesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
}

function buildCurrentSkillsHeadlinesData(
    bundleRoot: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesData {
    const currentState = collectCurrentSkillsHeadlinesState(bundleRoot);
    const payload = buildSkillsHeadlinesPayloadFromCurrentState(currentState, sourceStateHintSha256);
    return {
        headlinesPath: currentState.headlinesPath,
        sha256: computePayloadSha256(payload),
        payload
    };
}

function collectCurrentSkillsHeadlinesState(bundleRoot: string): CurrentSkillsHeadlinesState {
    const snapshots: SkillsHeadlinesSourceFileSnapshot[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    const installedPackIds = pathExists(skillPacksConfigPath)
        ? (() => {
            const snapshot = readJsonSourceFileSnapshot(bundleRoot, skillPacksConfigPath);
            snapshots.push(snapshot);
            return normalizeInstalledPackIds(snapshot.parsed.installed_packs);
        })()
        : [];

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    const builtinPacks: BuiltinSkillPackDefinition[] = pathExists(templateSkillPacksRoot)
        ? sortDirectoryEntries(fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const packRoot = path.join(templateSkillPacksRoot, entry.name);
                const packManifestPath = path.join(packRoot, 'pack.json');
                if (!pathExists(packManifestPath)) {
                    return null;
                }
                const packSnapshot = readJsonSourceFileSnapshot(bundleRoot, packManifestPath);
                snapshots.push(packSnapshot);
                const manifest = parsePackManifestSnapshot(packSnapshot);
                const skillsRoot = path.join(packRoot, 'skills');
                const skills = pathExists(skillsRoot)
                    ? sortDirectoryEntries(fs.readdirSync(skillsRoot, { withFileTypes: true }))
                        .filter((skillEntry) => skillEntry.isDirectory())
                        .map((skillEntry) => {
                            const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                            if (!pathExists(skillManifestPath)) {
                                return null;
                            }
                            const skillSnapshot = readJsonSourceFileSnapshot(bundleRoot, skillManifestPath);
                            snapshots.push(skillSnapshot);
                            return parseSkillManifestSnapshot(skillSnapshot, manifest.id);
                        })
                        .filter((skill): skill is SkillManifestDefinition => skill !== null)
                        .sort((left, right) => left.id.localeCompare(right.id))
                    : [];
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
            .filter((entry): entry is BuiltinSkillPackDefinition => entry !== null)
            .sort((left, right) => left.id.localeCompare(right.id))
        : [];

    const installedPackSet = new Set(installedPackIds);
    const installedOptionalSkillIds = builtinPacks
        .filter((pack) => installedPackSet.has(pack.id))
        .flatMap((pack) => pack.skillDirectories)
        .sort();
    const installedOptionalSkillSet = new Set(installedOptionalSkillIds);

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const liveSkillManifestSnapshotsByDirectory = new Map<string, SkillsHeadlinesSourceFileSnapshot>();
    const liveSkillDirectories = pathExists(liveSkillsRoot)
        ? sortDirectoryEntries(fs.readdirSync(liveSkillsRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const skillManifestPath = path.join(liveSkillsRoot, entry.name, 'skill.json');
                if (pathExists(skillManifestPath)) {
                    const skillSnapshot = readJsonSourceFileSnapshot(bundleRoot, skillManifestPath);
                    snapshots.push(skillSnapshot);
                    liveSkillManifestSnapshotsByDirectory.set(entry.name, skillSnapshot);
                }
                return entry.name;
            })
            .sort()
        : [];
    const customSkillIds = liveSkillDirectories
        .filter((skillId) => !BASELINE_SKILL_DIRECTORIES.includes(skillId) && !installedOptionalSkillSet.has(skillId))
        .sort();

    const baselineSkills: SkillsHeadlineSkillEntry[] = BASELINE_SKILL_DIRECTORIES
        .map((skillId): SkillsHeadlineSkillEntry | null => {
            const snapshot = liveSkillManifestSnapshotsByDirectory.get(skillId);
            if (!snapshot) {
                return null;
            }
            const manifest = parseBaselineSkillManifestSnapshot(snapshot);
            return {
                id: manifest.id,
                directory: skillId,
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
        })
        .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null);
    const installedOptionalSkills: SkillsHeadlineSkillEntry[] = installedOptionalSkillIds
        .map((skillId): SkillsHeadlineSkillEntry | null => {
            const snapshot = liveSkillManifestSnapshotsByDirectory.get(skillId);
            if (!snapshot) {
                return null;
            }
            const manifest = parseSkillManifestSnapshot(snapshot, skillId);
            return {
                id: manifest.id,
                directory: skillId,
                name: manifest.name,
                summary: manifest.summary,
                pack: manifest.pack || null,
                source: 'installed_optional',
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
        })
        .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null);
    const customSkills: SkillsHeadlineSkillEntry[] = customSkillIds
        .map((skillId): SkillsHeadlineSkillEntry | null => {
            const snapshot = liveSkillManifestSnapshotsByDirectory.get(skillId);
            if (!snapshot) {
                return null;
            }
            const manifest = parseSkillManifestSnapshot(snapshot, 'custom');
            return {
                id: manifest.id,
                directory: skillId,
                name: manifest.name,
                summary: manifest.summary,
                pack: manifest.pack || null,
                source: 'custom_live',
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
        })
        .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null);

    const skills: SkillsHeadlineSkillEntry[] = [
        ...baselineSkills,
        ...installedOptionalSkills,
        ...customSkills
    ].sort((left, right) => left.id.localeCompare(right.id));

    return {
        headlinesPath: getSkillsHeadlinesConfigPath(bundleRoot),
        snapshots,
        installedPackIds: [...installedPackIds],
        installedOptionalSkillIds: [...installedOptionalSkillIds],
        customSkillIds: [...customSkillIds],
        skills,
        optionalPacks: builtinPacks
            .map((pack) => toOptionalPackEntry(pack, installedPackIds))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

function buildSkillsHeadlinesPayloadFromCurrentState(
    currentState: CurrentSkillsHeadlinesState,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    return {
        version: SKILLS_HEADLINES_VERSION,
        source_state_sha256: computeSourceStateSha256FromSnapshots(currentState.snapshots),
        source_state_hint_sha256: sourceStateHintSha256 || computeSourceStateHintSha256FromSnapshots(currentState.snapshots),
        installed_pack_ids: [...currentState.installedPackIds],
        baseline_skill_ids: [...BASELINE_SKILL_DIRECTORIES],
        installed_optional_skill_ids: [...currentState.installedOptionalSkillIds],
        custom_skill_ids: [...currentState.customSkillIds],
        skills: currentState.skills,
        optional_packs: currentState.optionalPacks
    };
}

export function computeCurrentSkillsHeadlinesValidationState(bundleRoot: string): {
    sourceStateSha256: string;
    sourceStateHintSha256: string;
    selectionSurfaceSha256: string;
    payload: SkillsHeadlinesPayload;
} {
    const currentState = collectCurrentSkillsHeadlinesState(bundleRoot);
    const payload = buildSkillsHeadlinesPayloadFromCurrentState(currentState);
    return {
        sourceStateSha256: String(payload.source_state_sha256 || ''),
        sourceStateHintSha256: String(payload.source_state_hint_sha256 || ''),
        selectionSurfaceSha256: computeSkillsHeadlinesSelectionSurfaceSha256(payload),
        payload
    };
}

export function computeCurrentSkillsHeadlinesSourceState(bundleRoot: string): {
    sourceStateSha256: string;
    sourceStateHintSha256: string;
} {
    const snapshots: SkillsHeadlinesSourceFileSnapshot[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    if (pathExists(skillPacksConfigPath)) {
        snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillPacksConfigPath));
    }

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (pathExists(templateSkillPacksRoot)) {
        for (const packEntry of sortDirectoryEntries(fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true }))) {
            if (!packEntry.isDirectory()) {
                continue;
            }
            const packRoot = path.join(templateSkillPacksRoot, packEntry.name);
            const packManifestPath = path.join(packRoot, 'pack.json');
            if (!pathExists(packManifestPath)) {
                continue;
            }
            snapshots.push(readJsonSourceFileSnapshot(bundleRoot, packManifestPath));
            const skillsRoot = path.join(packRoot, 'skills');
            if (!pathExists(skillsRoot)) {
                continue;
            }
            for (const skillEntry of sortDirectoryEntries(fs.readdirSync(skillsRoot, { withFileTypes: true }))) {
                if (!skillEntry.isDirectory()) {
                    continue;
                }
                const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                if (pathExists(skillManifestPath)) {
                    snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillManifestPath));
                }
            }
        }
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (pathExists(liveSkillsRoot)) {
        for (const entry of sortDirectoryEntries(fs.readdirSync(liveSkillsRoot, { withFileTypes: true }))) {
            if (!entry.isDirectory()) {
                continue;
            }
            const skillManifestPath = path.join(liveSkillsRoot, entry.name, 'skill.json');
            if (pathExists(skillManifestPath)) {
                snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillManifestPath));
            }
        }
    }

    return {
        sourceStateSha256: computeSourceStateSha256FromSnapshots(snapshots),
        sourceStateHintSha256: computeSourceStateHintSha256FromSnapshots(snapshots)
    };
}

export function buildSkillsHeadlines(
    bundleRoot: string,
    sourceStateSha256?: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    if (!sourceStateSha256 || !sourceStateHintSha256) {
        const rebuilt = buildCurrentSkillsHeadlinesData(bundleRoot, sourceStateHintSha256);
        return {
            ...rebuilt.payload,
            source_state_sha256: sourceStateSha256 || rebuilt.payload.source_state_sha256,
            source_state_hint_sha256: sourceStateHintSha256 || rebuilt.payload.source_state_hint_sha256
        };
    }
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const installedPackIds = readInstalledPackIds(bundleRoot);
    const installedPackSet = new Set(installedPackIds);
    const installedOptionalSkillIds = builtinPacks
        .filter((pack) => installedPackSet.has(pack.id))
        .flatMap((pack) => pack.skillDirectories)
        .sort();
    const installedOptionalSkillSet = new Set(installedOptionalSkillIds);
    const liveSkillDirectories = listLiveSkillDirectories(bundleRoot);
    const customSkillIds = liveSkillDirectories
        .filter((skillId) => !BASELINE_SKILL_DIRECTORIES.includes(skillId) && !installedOptionalSkillSet.has(skillId))
        .sort();

    const skills = [
        ...BASELINE_SKILL_DIRECTORIES
            .map((skillId) => tryBuildBaselineSkillEntry(bundleRoot, skillId))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
        ...installedOptionalSkillIds
            .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'installed_optional', skillId))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
        ...customSkillIds
            .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'custom_live', 'custom'))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null)
    ].sort((left, right) => left.id.localeCompare(right.id));

    return {
        version: SKILLS_HEADLINES_VERSION,
        source_state_sha256: sourceStateSha256,
        source_state_hint_sha256: sourceStateHintSha256,
        installed_pack_ids: [...installedPackIds],
        baseline_skill_ids: [...BASELINE_SKILL_DIRECTORIES],
        installed_optional_skill_ids: [...installedOptionalSkillIds],
        custom_skill_ids: [...customSkillIds],
        skills,
        optional_packs: builtinPacks
            .map((pack) => toOptionalPackEntry(pack, installedPackIds))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

export function buildCurrentSkillsHeadlinesPayload(
    bundleRoot: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    return buildCurrentSkillsHeadlinesData(bundleRoot, sourceStateHintSha256).payload;
}

export function writeSkillsHeadlines(bundleRoot: string): string {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    ensureDirectory(path.dirname(headlinesPath));
    writeJsonFile(headlinesPath, buildSkillsHeadlines(bundleRoot));
    return headlinesPath;
}

export function ensureSkillsHeadlinesCurrent(bundleRoot: string): SkillsHeadlinesData {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);

    const expected = buildSkillsHeadlines(bundleRoot);
    const expectedSha256 = computePayloadSha256(expected);

    if (!pathExists(headlinesPath)) {
        ensureDirectory(path.dirname(headlinesPath));
        writeJsonFile(headlinesPath, expected);
        return {
            headlinesPath,
            sha256: expectedSha256,
            payload: expected
        };
    }

    try {
        const parsed = readJsonFile(headlinesPath);
        if (JSON.stringify(parsed) === JSON.stringify(expected)) {
            return {
                headlinesPath,
                sha256: expectedSha256,
                payload: expected
            };
        }
    } catch {
        // Refresh malformed artifacts from the current live skill surface.
    }

    ensureDirectory(path.dirname(headlinesPath));
    writeJsonFile(headlinesPath, expected);
    return {
        headlinesPath,
        sha256: expectedSha256,
        payload: expected
    };
}

export function readSkillsHeadlines(bundleRoot: string): SkillsHeadlinesData {
    const { headlinesPath, sha256, payload } = ensureSkillsHeadlinesCurrent(bundleRoot);
    const normalizedPayload = asObjectRecord(payload);
    if (!isValidSkillsHeadlinesPayload(normalizedPayload)) {
        throw new Error(`Skills headlines have an invalid shape: ${headlinesPath}`);
    }

    return {
        headlinesPath,
        sha256,
        payload: normalizedPayload as unknown as SkillsHeadlinesPayload
    };
}

export function readSkillsHeadlinesIfPresent(bundleRoot: string): SkillsHeadlinesData | null {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    if (!pathExists(headlinesPath)) {
        return null;
    }

    try {
        const fileText = fs.readFileSync(headlinesPath, 'utf8');
        const normalizedPayload = asObjectRecord(JSON.parse(fileText));
        if (!isValidSkillsHeadlinesPayload(normalizedPayload)) {
            return null;
        }
        return {
            headlinesPath,
            sha256: computeSha256FromText(fileText),
            payload: normalizedPayload as unknown as SkillsHeadlinesPayload
        };
    } catch {
        return null;
    }
}

export function validateSkillsHeadlines(bundleRoot: string) {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    const issues: string[] = [];
    const expected = buildSkillsHeadlines(bundleRoot);

    if (!pathExists(headlinesPath)) {
        issues.push(`Skills headlines are missing: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    let parsed: unknown = null;
    try {
        parsed = readJsonFile(headlinesPath);
    } catch {
        issues.push(`Skills headlines are not valid JSON: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    const actualSerialized = JSON.stringify(parsed);
    const expectedSerialized = JSON.stringify(expected);
    if (actualSerialized !== expectedSerialized) {
        issues.push(`Skills headlines are stale: ${headlinesPath}. Re-run init/materialization to refresh them.`);
    }

    return {
        headlinesPath,
        expected,
        issues,
        passed: issues.length === 0
    };
}
