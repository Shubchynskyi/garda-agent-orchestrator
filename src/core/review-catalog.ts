import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import {
    REVIEW_CAPABILITY_KEYS,
    getReviewSkillCandidates,
    listKnownReviewSkillDirectories
} from './review-capabilities';

export const REVIEW_CATALOG_SCHEMA_VERSION = 1;
export const MAX_REVIEW_CATALOG_FILE_BYTES = 65_536;
export const MAX_CUSTOM_REVIEW_TYPES = 32;

export const BUILT_IN_REVIEW_TYPE_IDS = Object.freeze([...REVIEW_CAPABILITY_KEYS]);

export const REVIEW_COVERAGE_CATEGORY_IDS = Object.freeze([
    'api-contracts',
    'code-quality',
    'data-integrity',
    'dependencies',
    'infrastructure',
    'maintainability',
    'performance',
    'security',
    'testing'
] as const);

export type ReviewCoverageCategoryId = (typeof REVIEW_COVERAGE_CATEGORY_IDS)[number];
export type ReviewTriggerMode = 'compatibility' | 'manual' | 'signals';

export interface NormalizedReviewTrigger {
    mode: ReviewTriggerMode;
    signal_ids: readonly string[];
}

export interface NormalizedReviewerRole {
    role_id: string;
    focus_tags: readonly string[];
}

export interface ReviewVerdictTokens {
    pass: string;
    fail: string;
}

export interface NormalizedReviewTypeDefinition {
    id: string;
    display_label: string;
    built_in: boolean;
    enabled_by_default: boolean;
    skill_ids: readonly string[];
    trigger: NormalizedReviewTrigger;
    coverage_category_ids: readonly ReviewCoverageCategoryId[];
    reviewer_role: NormalizedReviewerRole;
    verdict_tokens: ReviewVerdictTokens;
}

export interface NormalizedReviewCatalog {
    schema_version: typeof REVIEW_CATALOG_SCHEMA_VERSION;
    review_types: readonly NormalizedReviewTypeDefinition[];
    catalog_sha256: string;
}

export interface NormalizeReviewCatalogOptions {
    knownSkillIds?: readonly string[];
}

const MAX_DISPLAY_LABEL_LENGTH = 80;
const MAX_STABLE_ID_LENGTH = 48;
const MAX_SIGNAL_ID_LENGTH = 64;
const MAX_FOCUS_TAGS = 8;
const MAX_TRIGGER_SIGNALS = 16;
const MAX_COVERAGE_CATEGORIES = 8;
const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SIGNAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/u;

const BUILT_IN_DISPLAY_LABELS: Readonly<Record<string, string>> = Object.freeze({
    code: 'Code review',
    db: 'Database review',
    security: 'Security review',
    refactor: 'Refactor review',
    api: 'API review',
    test: 'Test review',
    performance: 'Performance review',
    infra: 'Infrastructure review',
    dependency: 'Dependency review'
});

const BUILT_IN_COVERAGE: Readonly<Record<string, readonly ReviewCoverageCategoryId[]>> = Object.freeze({
    code: ['code-quality', 'maintainability'],
    db: ['data-integrity'],
    security: ['security'],
    refactor: ['maintainability'],
    api: ['api-contracts'],
    test: ['testing'],
    performance: ['performance'],
    infra: ['infrastructure'],
    dependency: ['dependencies']
});

const BUILT_IN_PASS_TOKENS: Readonly<Record<string, string>> = Object.freeze({
    code: 'REVIEW PASSED',
    db: 'DB REVIEW PASSED',
    security: 'SECURITY REVIEW PASSED',
    refactor: 'REFACTOR REVIEW PASSED',
    api: 'API REVIEW PASSED',
    test: 'TEST REVIEW PASSED',
    performance: 'PERFORMANCE REVIEW PASSED',
    infra: 'INFRA REVIEW PASSED',
    dependency: 'DEPENDENCY REVIEW PASSED'
});

const ROOT_KEYS = new Set(['version', 'custom_review_types']);
const CUSTOM_DEFINITION_KEYS = new Set([
    'id',
    'display_label',
    'enabled_by_default',
    'skill_id',
    'trigger',
    'coverage_category_ids',
    'reviewer_role'
]);
const PROMPT_BODY_KEYS = new Set([
    'prompt',
    'prompt_body',
    'prompt_template',
    'reviewer_prompt',
    'system_prompt',
    'instructions'
]);
const VERDICT_OVERRIDE_KEYS = new Set([
    'pass_token',
    'fail_token',
    'pass_verdict',
    'fail_verdict',
    'verdict_tokens'
]);

function ensurePlainObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, knownKeys: ReadonlySet<string>, label: string): void {
    for (const key of Object.keys(value)) {
        const normalizedKey = key.toLowerCase();
        if (PROMPT_BODY_KEYS.has(normalizedKey) || normalizedKey.includes('prompt')) {
            throw new Error(`${label}.${key}: raw prompt bodies are not allowed in the review catalog.`);
        }
        if (VERDICT_OVERRIDE_KEYS.has(normalizedKey) || normalizedKey.includes('verdict')) {
            throw new Error(`${label}.${key}: verdict token overrides are not allowed; tokens are generated canonically.`);
        }
        if (!knownKeys.has(key)) {
            throw new Error(`${label}.${key} is not a supported property.`);
        }
    }
}

function normalizeRequiredString(value: unknown, label: string, maximumLength: number): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    const normalized = value.trim();
    if (normalized.length > maximumLength) {
        throw new Error(`${label} must be at most ${maximumLength} characters.`);
    }
    return normalized;
}

function normalizeStableId(value: unknown, label: string, maximumLength = MAX_STABLE_ID_LENGTH): string {
    const normalized = normalizeRequiredString(value, label, maximumLength);
    if (!STABLE_ID_PATTERN.test(normalized)) {
        throw new Error(`${label} must be a lowercase stable id using letters, digits, and single hyphens.`);
    }
    return normalized;
}

function normalizeBoundedIdArray(
    value: unknown,
    label: string,
    options: {
        maximumEntries: number;
        maximumIdLength?: number;
        pattern?: RegExp;
        requireNonEmpty?: boolean;
    }
): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    if (options.requireNonEmpty && value.length === 0) {
        throw new Error(`${label} must contain at least one entry.`);
    }
    if (value.length > options.maximumEntries) {
        throw new Error(`${label} must contain at most ${options.maximumEntries} entries.`);
    }

    const normalized = value.map((entry, index) => {
        const id = normalizeRequiredString(
            entry,
            `${label}[${index}]`,
            options.maximumIdLength ?? MAX_STABLE_ID_LENGTH
        );
        const pattern = options.pattern ?? STABLE_ID_PATTERN;
        if (!pattern.test(id)) {
            throw new Error(`${label}[${index}] must be a lowercase stable id.`);
        }
        return id;
    });
    const seen = new Set<string>();
    for (const id of normalized) {
        const folded = id.toLowerCase();
        if (seen.has(folded)) {
            throw new Error(`${label} contains duplicate or case-drifted id '${folded}'.`);
        }
        seen.add(folded);
    }
    return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeTrigger(value: unknown, label: string): NormalizedReviewTrigger {
    const raw = ensurePlainObject(value, label);
    if (raw.mode !== 'manual' && raw.mode !== 'signals') {
        throw new Error(`${label}.mode must be 'manual' or 'signals'.`);
    }
    assertKnownKeys(raw, new Set(['mode', 'signal_ids']), label);

    const signalIds = raw.signal_ids === undefined
        ? []
        : normalizeBoundedIdArray(raw.signal_ids, `${label}.signal_ids`, {
            maximumEntries: MAX_TRIGGER_SIGNALS,
            maximumIdLength: MAX_SIGNAL_ID_LENGTH,
            pattern: SIGNAL_ID_PATTERN
        });
    if (raw.mode === 'signals' && signalIds.length === 0) {
        throw new Error(`${label}.signal_ids must contain at least one entry when mode is 'signals'.`);
    }
    if (raw.mode === 'manual' && signalIds.length > 0) {
        throw new Error(`${label}.signal_ids must be empty when mode is 'manual'.`);
    }
    return { mode: raw.mode, signal_ids: signalIds };
}

function normalizeReviewerRole(value: unknown, label: string): NormalizedReviewerRole {
    const raw = ensurePlainObject(value, label);
    assertKnownKeys(raw, new Set(['role_id', 'focus_tags']), label);
    const focusTags = raw.focus_tags === undefined
        ? []
        : normalizeBoundedIdArray(raw.focus_tags, `${label}.focus_tags`, {
            maximumEntries: MAX_FOCUS_TAGS
        });
    return {
        role_id: normalizeStableId(raw.role_id, `${label}.role_id`),
        focus_tags: focusTags
    };
}

function normalizeCoverageCategories(value: unknown, label: string): ReviewCoverageCategoryId[] {
    const normalized = normalizeBoundedIdArray(value, label, {
        maximumEntries: MAX_COVERAGE_CATEGORIES,
        requireNonEmpty: true
    });
    const knownCategories = new Set<string>(REVIEW_COVERAGE_CATEGORY_IDS);
    for (const categoryId of normalized) {
        if (!knownCategories.has(categoryId)) {
            throw new Error(`${label} contains unknown category '${categoryId}'.`);
        }
    }
    return normalized as ReviewCoverageCategoryId[];
}

function buildCustomVerdictTokens(reviewTypeId: string): ReviewVerdictTokens {
    const label = reviewTypeId.toUpperCase().replace(/-/g, ' ');
    return {
        pass: `${label} REVIEW PASSED`,
        fail: `${label} REVIEW FAILED`
    };
}

export function buildBuiltInReviewTypeDefinitions(): NormalizedReviewTypeDefinition[] {
    return BUILT_IN_REVIEW_TYPE_IDS.map((id) => ({
        id,
        display_label: BUILT_IN_DISPLAY_LABELS[id],
        built_in: true,
        enabled_by_default: true,
        skill_ids: getReviewSkillCandidates(id),
        trigger: { mode: 'compatibility', signal_ids: [] },
        coverage_category_ids: [...BUILT_IN_COVERAGE[id]],
        reviewer_role: {
            role_id: `${id}-reviewer`,
            focus_tags: [...BUILT_IN_COVERAGE[id]]
        },
        verdict_tokens: {
            pass: BUILT_IN_PASS_TOKENS[id],
            fail: BUILT_IN_PASS_TOKENS[id].replace(/PASSED$/u, 'FAILED')
        }
    }));
}

function normalizeCustomDefinition(
    raw: Record<string, unknown>,
    index: number,
    knownSkillIds: ReadonlySet<string>
): NormalizedReviewTypeDefinition {
    const label = `review-catalog.custom_review_types[${index}]`;
    assertKnownKeys(raw, CUSTOM_DEFINITION_KEYS, label);
    const id = normalizeStableId(raw.id, `${label}.id`);
    if (raw.enabled_by_default !== false) {
        throw new Error(`${label}.enabled_by_default must be false for custom review types.`);
    }
    const skillId = normalizeStableId(raw.skill_id, `${label}.skill_id`);
    if (!knownSkillIds.has(skillId)) {
        throw new Error(`${label}.skill_id '${skillId}' is not a known review skill.`);
    }

    return {
        id,
        display_label: normalizeRequiredString(raw.display_label, `${label}.display_label`, MAX_DISPLAY_LABEL_LENGTH),
        built_in: false,
        enabled_by_default: false,
        skill_ids: [skillId],
        trigger: normalizeTrigger(raw.trigger, `${label}.trigger`),
        coverage_category_ids: normalizeCoverageCategories(
            raw.coverage_category_ids,
            `${label}.coverage_category_ids`
        ),
        reviewer_role: normalizeReviewerRole(raw.reviewer_role, `${label}.reviewer_role`),
        verdict_tokens: buildCustomVerdictTokens(id)
    };
}

function canonicalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalizeJsonValue(entry));
    }
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        return Object.keys(source).sort().reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalizeJsonValue(source[key]);
            return result;
        }, {});
    }
    return value;
}

function computeCatalogSha256(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalizeJsonValue(value)), 'utf8')
        .digest('hex');
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function assertSerializedSize(input: unknown): void {
    let serialized: string;
    try {
        serialized = JSON.stringify(input);
    } catch (error: unknown) {
        throw new Error(`review-catalog must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (serialized === undefined) {
        throw new Error('review-catalog must be JSON-serializable.');
    }
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > MAX_REVIEW_CATALOG_FILE_BYTES) {
        throw new Error(`review-catalog exceeds the ${MAX_REVIEW_CATALOG_FILE_BYTES}-byte limit.`);
    }
}

export function normalizeReviewCatalog(
    input: unknown,
    options: NormalizeReviewCatalogOptions = {}
): NormalizedReviewCatalog {
    assertSerializedSize(input);
    const raw = ensurePlainObject(input, 'review-catalog');
    assertKnownKeys(raw, ROOT_KEYS, 'review-catalog');
    if (raw.version !== REVIEW_CATALOG_SCHEMA_VERSION) {
        throw new Error(`review-catalog.version must be ${REVIEW_CATALOG_SCHEMA_VERSION}.`);
    }
    if (!Array.isArray(raw.custom_review_types)) {
        throw new Error('review-catalog.custom_review_types must be an array.');
    }
    if (raw.custom_review_types.length > MAX_CUSTOM_REVIEW_TYPES) {
        throw new Error(`review-catalog.custom_review_types must contain at most ${MAX_CUSTOM_REVIEW_TYPES} entries.`);
    }

    const builtInIds = new Set<string>(BUILT_IN_REVIEW_TYPE_IDS);
    const customIds = new Set<string>();
    const customRawDefinitions = raw.custom_review_types.map((entry, index) => {
        const definition = ensurePlainObject(entry, `review-catalog.custom_review_types[${index}]`);
        const rawId = typeof definition.id === 'string' ? definition.id.trim() : '';
        const foldedId = rawId.toLowerCase();
        if (builtInIds.has(foldedId)) {
            throw new Error(`review-catalog custom definition '${rawId}' duplicates built-in review id '${foldedId}'.`);
        }
        if (foldedId && customIds.has(foldedId)) {
            throw new Error(`review-catalog contains duplicate review id '${foldedId}' (including case drift).`);
        }
        if (foldedId) {
            customIds.add(foldedId);
        }
        return definition;
    });

    const knownSkillIds = new Set(
        (options.knownSkillIds ?? listKnownReviewSkillDirectories()).map((skillId) => String(skillId).trim())
    );
    const customDefinitions = customRawDefinitions
        .map((definition, index) => normalizeCustomDefinition(definition, index, knownSkillIds))
        .sort((left, right) => left.id.localeCompare(right.id));
    const reviewTypes = [...buildBuiltInReviewTypeDefinitions(), ...customDefinitions];
    const payload: Omit<NormalizedReviewCatalog, 'catalog_sha256'> = {
        schema_version: REVIEW_CATALOG_SCHEMA_VERSION,
        review_types: reviewTypes
    };
    return deepFreeze({
        ...payload,
        catalog_sha256: computeCatalogSha256(payload)
    });
}

export function readReviewCatalogConfigFile(
    configPath: string,
    options: NormalizeReviewCatalogOptions = {}
): NormalizedReviewCatalog {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return normalizeReviewCatalog({ version: REVIEW_CATALOG_SCHEMA_VERSION, custom_review_types: [] }, options);
    }
    const fileSize = fs.statSync(configPath).size;
    if (fileSize > MAX_REVIEW_CATALOG_FILE_BYTES) {
        throw new Error(`Review catalog config at '${configPath}' exceeds the ${MAX_REVIEW_CATALOG_FILE_BYTES}-byte limit.`);
    }

    const content = fs.readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_REVIEW_CATALOG_FILE_BYTES) {
        throw new Error(`Review catalog config at '${configPath}' exceeds the ${MAX_REVIEW_CATALOG_FILE_BYTES}-byte limit.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        throw new Error(
            `Review catalog config at '${configPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    return normalizeReviewCatalog(parsed, options);
}
