import { MANAGED_CONFIG_NAMES } from '../core/constants';
import {
    cloneUnknownProperties,
    ensurePlainObject,
    normalizeBooleanLike,
    normalizeInteger,
    normalizeNonEmptyString,
    normalizeOptionalString,
    normalizeStringArray
} from './shared';

interface IntegerArrayOptions {
    allowScalar?: boolean;
    minimum?: number;
    maximum?: number;
}

function normalizeIntegerArray(value: unknown, fieldName: string, options: IntegerArrayOptions = {}): number[] {
    const allowScalar = options.allowScalar === true;
    const items = Array.isArray(value) ? value : (allowScalar ? [value] : null);

    if (!items) {
        throw new Error(`${fieldName} must be an array.`);
    }

    const normalized: number[] = [];
    for (const item of items) {
        const integerValue = normalizeInteger(item, fieldName, options);
        if (!normalized.includes(integerValue)) {
            normalized.push(integerValue);
        }
    }

    return normalized.sort((left, right) => left - right);
}

export function validateReviewCapabilitiesConfig(input: unknown): Record<string, boolean> {
    const raw = ensurePlainObject(input, 'review-capabilities');
    const normalized: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(raw)) {
        normalized[key] = normalizeBooleanLike(value, `review-capabilities.${key}`);
    }

    for (const requiredKey of ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency']) {
        if (!(requiredKey in normalized)) {
            throw new Error(`review-capabilities.${requiredKey} is required.`);
        }
    }

    return normalized;
}

export function validatePathsConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'paths');
    const knownKeys = new Set([
        'metrics_path',
        'runtime_roots',
        'fast_path_roots',
        'fast_path_allowed_regexes',
        'fast_path_sensitive_regexes',
        'sql_or_migration_regexes',
        'triggers',
        'code_like_regexes'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.metrics_path = normalizeNonEmptyString(raw.metrics_path, 'paths.metrics_path');
    normalized.runtime_roots = normalizeStringArray(raw.runtime_roots, 'paths.runtime_roots', { allowScalar: true });
    normalized.fast_path_roots = normalizeStringArray(raw.fast_path_roots, 'paths.fast_path_roots', { allowScalar: true });

    if (raw.fast_path_allowed_regexes !== undefined) {
        normalized.fast_path_allowed_regexes = normalizeStringArray(raw.fast_path_allowed_regexes, 'paths.fast_path_allowed_regexes', { allowScalar: true });
    }

    if (raw.fast_path_sensitive_regexes !== undefined) {
        normalized.fast_path_sensitive_regexes = normalizeStringArray(raw.fast_path_sensitive_regexes, 'paths.fast_path_sensitive_regexes', { allowScalar: true });
    }

    if (raw.sql_or_migration_regexes !== undefined) {
        normalized.sql_or_migration_regexes = normalizeStringArray(raw.sql_or_migration_regexes, 'paths.sql_or_migration_regexes', { allowScalar: true });
    }

    if (raw.code_like_regexes !== undefined) {
        normalized.code_like_regexes = normalizeStringArray(raw.code_like_regexes, 'paths.code_like_regexes', { allowScalar: true });
    }

    const triggers = ensurePlainObject(raw.triggers, 'paths.triggers');
    const triggersMap: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(triggers)) {
        triggersMap[key] = normalizeStringArray(value, `paths.triggers.${key}`, { allowScalar: true });
    }

    if (Object.keys(triggersMap).length === 0) {
        throw new Error('paths.triggers must not be empty.');
    }

    normalized.triggers = triggersMap;

    return normalized;
}

export function validateTokenEconomyConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'token-economy');
    const knownKeys = new Set([
        'enabled',
        'enabled_depths',
        'strip_examples',
        'strip_code_blocks',
        'scoped_diffs',
        'compact_reviewer_output',
        'fail_tail_lines'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.enabled = normalizeBooleanLike(raw.enabled, 'token-economy.enabled');
    normalized.enabled_depths = normalizeIntegerArray(raw.enabled_depths, 'token-economy.enabled_depths', { allowScalar: true, minimum: 0 });
    normalized.strip_examples = normalizeBooleanLike(raw.strip_examples, 'token-economy.strip_examples');
    normalized.strip_code_blocks = normalizeBooleanLike(raw.strip_code_blocks, 'token-economy.strip_code_blocks');
    normalized.scoped_diffs = normalizeBooleanLike(raw.scoped_diffs, 'token-economy.scoped_diffs');
    normalized.compact_reviewer_output = normalizeBooleanLike(raw.compact_reviewer_output, 'token-economy.compact_reviewer_output');
    normalized.fail_tail_lines = normalizeInteger(raw.fail_tail_lines, 'token-economy.fail_tail_lines', { minimum: 1 });

    return normalized;
}

function validateContextLookupObject(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    return {
        ...raw,
        context_key: normalizeNonEmptyString(raw.context_key, `${fieldName}.context_key`)
    };
}

function validateOutputFilterOperation(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['type', 'pattern', 'replacement', 'suffix', 'max_chars']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.type = normalizeNonEmptyString(raw.type, `${fieldName}.type`);
    if (raw.pattern !== undefined) {
        normalized.pattern = normalizeNonEmptyString(raw.pattern, `${fieldName}.pattern`);
    }

    if (raw.replacement !== undefined) {
        normalized.replacement = normalizeOptionalString(raw.replacement) ?? '';
    }

    if (raw.suffix !== undefined) {
        normalized.suffix = normalizeOptionalString(raw.suffix) ?? '';
    }

    if (raw.max_chars !== undefined) {
        normalized.max_chars = normalizeInteger(raw.max_chars, `${fieldName}.max_chars`, { minimum: 1 });
    }

    return normalized;
}

function validateOutputFilterParser(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['type', 'strategy', 'max_matches', 'tail_count', 'max_lines']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.type = normalizeNonEmptyString(raw.type, `${fieldName}.type`);

    if (raw.strategy !== undefined) {
        normalized.strategy = typeof raw.strategy === 'string'
            ? normalizeNonEmptyString(raw.strategy, `${fieldName}.strategy`)
            : validateContextLookupObject(raw.strategy, `${fieldName}.strategy`);
    }

    if (raw.max_matches !== undefined) {
        normalized.max_matches = normalizeInteger(raw.max_matches, `${fieldName}.max_matches`, { minimum: 1 });
    }

    if (raw.max_lines !== undefined) {
        normalized.max_lines = normalizeInteger(raw.max_lines, `${fieldName}.max_lines`, { minimum: 1 });
    }

    if (raw.tail_count !== undefined) {
        normalized.tail_count = (typeof raw.tail_count === 'object' && raw.tail_count !== null)
            ? validateContextLookupObject(raw.tail_count, `${fieldName}.tail_count`)
            : normalizeInteger(raw.tail_count, `${fieldName}.tail_count`, { minimum: 1 });
    }

    return normalized;
}

function validateOutputFilterProfile(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['description', 'emit_when_empty', 'operations', 'parser']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.description = normalizeNonEmptyString(raw.description, `${fieldName}.description`);
    if (raw.emit_when_empty !== undefined) {
        normalized.emit_when_empty = normalizeOptionalString(raw.emit_when_empty) ?? '';
    }

    if (raw.operations !== undefined) {
        if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
            throw new Error(`${fieldName}.operations must be a non-empty array.`);
        }

        normalized.operations = raw.operations.map((operation, index) => (
            validateOutputFilterOperation(operation, `${fieldName}.operations[${index}]`)
        ));
    }

    if (raw.parser !== undefined) {
        normalized.parser = validateOutputFilterParser(raw.parser, `${fieldName}.parser`);
    }

    if (normalized.operations === undefined && normalized.parser === undefined) {
        throw new Error(`${fieldName} must define operations, parser, or both.`);
    }

    return normalized;
}

export function validateOutputFiltersConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'output-filters');
    const knownKeys = new Set(['version', 'passthrough_ceiling', 'profiles']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'output-filters.version', { minimum: 1 });
    if (raw.passthrough_ceiling !== undefined) {
        const passthrough = ensurePlainObject(raw.passthrough_ceiling, 'output-filters.passthrough_ceiling');
        normalized.passthrough_ceiling = {
            ...passthrough,
            max_lines: normalizeInteger(passthrough.max_lines, 'output-filters.passthrough_ceiling.max_lines', { minimum: 1 }),
            strategy: normalizeNonEmptyString(passthrough.strategy, 'output-filters.passthrough_ceiling.strategy')
        };
    }

    const profiles = ensurePlainObject(raw.profiles, 'output-filters.profiles');
    const profilesMap: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(profiles)) {
        profilesMap[key] = validateOutputFilterProfile(value, `output-filters.profiles.${key}`);
    }

    if (Object.keys(profilesMap).length === 0) {
        throw new Error('output-filters.profiles must not be empty.');
    }

    normalized.profiles = profilesMap;

    return normalized;
}

export function validateSkillPacksConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'skill-packs');
    const knownKeys = new Set(['version', 'installed_packs']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'skill-packs.version', { minimum: 1 });

    const installedPacks = normalizeStringArray(raw.installed_packs, 'skill-packs.installed_packs', { allowScalar: true });
    normalized.installed_packs = Array.from(new Set(installedPacks));

    return normalized;
}

export function validateIsolationModeConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'isolation-mode');
    const knownKeys = new Set([
        'enabled',
        'enforcement',
        'require_manifest_match_before_task',
        'refuse_on_preflight_drift',
        'use_sandbox',
        'same_user_limitation_notice'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.enabled = normalizeBooleanLike(raw.enabled, 'isolation-mode.enabled');
    normalized.enforcement = normalizeNonEmptyString(raw.enforcement, 'isolation-mode.enforcement');
    if (normalized.enforcement !== 'STRICT' && normalized.enforcement !== 'LOG_ONLY') {
        throw new Error("isolation-mode.enforcement must be 'STRICT' or 'LOG_ONLY'.");
    }
    normalized.require_manifest_match_before_task = normalizeBooleanLike(
        raw.require_manifest_match_before_task,
        'isolation-mode.require_manifest_match_before_task'
    );
    normalized.refuse_on_preflight_drift = normalizeBooleanLike(
        raw.refuse_on_preflight_drift,
        'isolation-mode.refuse_on_preflight_drift'
    );
    normalized.use_sandbox = normalizeBooleanLike(raw.use_sandbox, 'isolation-mode.use_sandbox');

    if (raw.same_user_limitation_notice !== undefined) {
        normalized.same_user_limitation_notice = normalizeNonEmptyString(
            raw.same_user_limitation_notice,
            'isolation-mode.same_user_limitation_notice'
        );
    }

    return normalized;
}

const VALID_REVIEW_POLICY_VALUES = new Set<unknown>([true, false, 'auto']);
const BUILT_IN_PROFILE_NAMES = ['balanced', 'fast', 'strict', 'docs-only'] as const;

function normalizeReviewPolicyValue(value: unknown, fieldName: string): boolean | 'auto' {
    if (value === 'auto') {
        return 'auto';
    }
    return normalizeBooleanLike(value, fieldName);
}

function validateProfileEntry(input: unknown, profilePath: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, profilePath);
    const knownKeys = new Set(['description', 'depth', 'review_policy', 'token_economy', 'skills']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.description = normalizeNonEmptyString(raw.description, `${profilePath}.description`);
    normalized.depth = normalizeInteger(raw.depth, `${profilePath}.depth`, { minimum: 1, maximum: 3 });

    const reviewPolicyRaw = ensurePlainObject(raw.review_policy, `${profilePath}.review_policy`);
    const reviewPolicy: Record<string, boolean | 'auto'> = {};
    for (const [key, value] of Object.entries(reviewPolicyRaw)) {
        reviewPolicy[key] = normalizeReviewPolicyValue(value, `${profilePath}.review_policy.${key}`);
    }
    normalized.review_policy = reviewPolicy;

    const ALLOWED_TOKEN_ECONOMY_KEYS = new Set(['enabled', 'strip_examples', 'strip_code_blocks', 'scoped_diffs', 'compact_reviewer_output']);
    const tokenEconomyRaw = ensurePlainObject(raw.token_economy, `${profilePath}.token_economy`);
    const tokenEconomy: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(tokenEconomyRaw)) {
        if (!ALLOWED_TOKEN_ECONOMY_KEYS.has(key)) {
            throw new Error(`${profilePath}.token_economy.${key} is not a recognized token_economy key.`);
        }
        tokenEconomy[key] = normalizeBooleanLike(value, `${profilePath}.token_economy.${key}`);
    }
    normalized.token_economy = tokenEconomy;

    const ALLOWED_SKILLS_KEYS = new Set(['auto_suggest']);
    const skillsRaw = ensurePlainObject(raw.skills, `${profilePath}.skills`);
    const skills: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(skillsRaw)) {
        if (!ALLOWED_SKILLS_KEYS.has(key)) {
            throw new Error(`${profilePath}.skills.${key} is not a recognized skills key.`);
        }
        skills[key] = normalizeBooleanLike(value, `${profilePath}.skills.${key}`);
    }
    normalized.skills = skills;

    return normalized;
}

export function validateProfilesConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'profiles');
    const knownKeys = new Set(['version', 'active_profile', 'built_in_profiles', 'user_profiles']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'profiles.version', { minimum: 1 });
    normalized.active_profile = normalizeNonEmptyString(raw.active_profile, 'profiles.active_profile');

    const builtInRaw = ensurePlainObject(raw.built_in_profiles, 'profiles.built_in_profiles');
    const builtIn: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(builtInRaw)) {
        builtIn[name] = validateProfileEntry(entry, `profiles.built_in_profiles.${name}`);
    }
    if (Object.keys(builtIn).length === 0) {
        throw new Error('profiles.built_in_profiles must contain at least one profile.');
    }
    normalized.built_in_profiles = builtIn;

    const userRaw = ensurePlainObject(raw.user_profiles, 'profiles.user_profiles');
    const user: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(userRaw)) {
        if (name in builtIn) {
            throw new Error(`profiles.user_profiles.${name} conflicts with a built-in profile name.`);
        }
        user[name] = validateProfileEntry(entry, `profiles.user_profiles.${name}`);
    }
    normalized.user_profiles = user;

    const allProfileNames = new Set([...Object.keys(builtIn), ...Object.keys(user)]);
    if (!allProfileNames.has(normalized.active_profile as string)) {
        throw new Error(
            `profiles.active_profile '${normalized.active_profile}' does not match any built-in or user profile.`
        );
    }

    return normalized;
}

const VALID_RETENTION_MODES = new Set(['none', 'summary', 'full']);
const VALID_COMPRESSION_FORMATS = new Set(['gzip']);

export function validateReviewArtifactStorageConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'review-artifact-storage');
    const knownKeys = new Set([
        'version',
        'retention_mode',
        'compress_after_days',
        'compression_format',
        'preserve_gate_receipts',
        'gate_receipt_suffixes',
        'privacy_notice'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'review-artifact-storage.version', { minimum: 1 });

    const mode = normalizeNonEmptyString(raw.retention_mode, 'review-artifact-storage.retention_mode').toLowerCase();
    if (!VALID_RETENTION_MODES.has(mode)) {
        throw new Error(
            `review-artifact-storage.retention_mode must be one of: ${[...VALID_RETENTION_MODES].join(', ')}.`
        );
    }
    normalized.retention_mode = mode;

    normalized.compress_after_days = normalizeInteger(
        raw.compress_after_days,
        'review-artifact-storage.compress_after_days',
        { minimum: 0 }
    );

    const format = normalizeNonEmptyString(
        raw.compression_format,
        'review-artifact-storage.compression_format'
    ).toLowerCase();
    if (!VALID_COMPRESSION_FORMATS.has(format)) {
        throw new Error(
            `review-artifact-storage.compression_format must be one of: ${[...VALID_COMPRESSION_FORMATS].join(', ')}.`
        );
    }
    normalized.compression_format = format;

    normalized.preserve_gate_receipts = normalizeBooleanLike(
        raw.preserve_gate_receipts,
        'review-artifact-storage.preserve_gate_receipts'
    );

    const suffixes = normalizeStringArray(
        raw.gate_receipt_suffixes,
        'review-artifact-storage.gate_receipt_suffixes',
        { allowScalar: true }
    );

    if (suffixes.length === 0) {
        throw new Error('review-artifact-storage.gate_receipt_suffixes must not be empty.');
    }

    normalized.gate_receipt_suffixes = suffixes;

    if (raw.privacy_notice !== undefined) {
        normalized.privacy_notice = normalizeOptionalString(raw.privacy_notice) ?? '';
    }

    return normalized;
}

const MANAGED_CONFIG_VALIDATORS = Object.freeze({
    'review-capabilities': validateReviewCapabilitiesConfig,
    paths: validatePathsConfig,
    'token-economy': validateTokenEconomyConfig,
    'output-filters': validateOutputFiltersConfig,
    'skill-packs': validateSkillPacksConfig,
    'isolation-mode': validateIsolationModeConfig,
    profiles: validateProfilesConfig,
    'review-artifact-storage': validateReviewArtifactStorageConfig
});

function normalizeManagedConfigName(configName: unknown): string {
    const normalized = normalizeNonEmptyString(configName, 'configName').toLowerCase();
    const match = MANAGED_CONFIG_NAMES.find((candidate) => candidate.toLowerCase() === normalized);

    if (!match) {
        throw new Error(`Unsupported managed config '${configName}'.`);
    }

    return match;
}

export function validateManagedConfigByName(configName: unknown, input: unknown): Record<string, unknown> {
    const normalizedName = normalizeManagedConfigName(configName);
    const validators = MANAGED_CONFIG_VALIDATORS as Record<string, (input: unknown) => Record<string, unknown>>;
    return validators[normalizedName](input);
}

export function getManagedConfigValidators() {
    return MANAGED_CONFIG_VALIDATORS;
}
