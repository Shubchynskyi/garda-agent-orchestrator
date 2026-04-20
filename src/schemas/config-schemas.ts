/**
 * Portable JSON Schema definitions for all managed config files.
 *
 * Each schema is a plain object following the JSON Schema draft-07 spec.
 * Schemas can be serialized to `.json` for external tooling or used in-process
 * for programmatic validation via {@link validateConfigAgainstSchema}.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePlainObject } from './shared';
import { getManagedConfigValidators } from './config-artifacts';
import {
    SOURCE_OF_TRUTH_VALUES,
    BREVITY_VALUES,
    COLLECTED_VIA_VALUES
} from '../core/constants';

// ---------------------------------------------------------------------------
// Individual config schemas
// ---------------------------------------------------------------------------

const REVIEW_CAPABILITY_KEYS = [
    'code', 'db', 'security', 'refactor',
    'api', 'test', 'performance', 'infra', 'dependency'
] as const;

export const reviewCapabilitiesSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/review-capabilities.schema.json',
    title: 'Review Capabilities',
    description: 'Toggles for mandatory and optional review types.',
    type: 'object',
    properties: Object.fromEntries(
        REVIEW_CAPABILITY_KEYS.map((key) => [key, { type: 'boolean', description: `Enable ${key} review.` }])
    ),
    required: [...REVIEW_CAPABILITY_KEYS],
    additionalProperties: false
});

export const tokenEconomySchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/token-economy.schema.json',
    title: 'Token Economy',
    description: 'Reviewer-context compaction and token-saving settings.',
    type: 'object',
    properties: {
        enabled:                 { type: 'boolean', description: 'Enable token economy.' },
        enabled_depths:          { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Depths at which compaction is active.' },
        strip_examples:          { type: 'boolean', description: 'Strip examples from reviewer context.' },
        strip_code_blocks:       { type: 'boolean', description: 'Strip code blocks from reviewer context.' },
        scoped_diffs:            { type: 'boolean', description: 'Generate scoped diffs for specialist reviewers.' },
        compact_reviewer_output: { type: 'boolean', description: 'Compact reviewer output.' },
        fail_tail_lines:         { type: 'integer', minimum: 1, description: 'Lines of failure tail to include.' }
    },
    required: [
        'enabled', 'enabled_depths', 'strip_examples', 'strip_code_blocks',
        'scoped_diffs', 'compact_reviewer_output', 'fail_tail_lines'
    ],
    additionalProperties: true
});

export const pathsSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/paths.schema.json',
    title: 'Paths Configuration',
    description: 'Classification roots, trigger regexes, and runtime paths.',
    type: 'object',
    properties: {
        metrics_path:                { type: 'string', minLength: 1, description: 'Relative path for runtime metrics.' },
        runtime_roots:               { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Root directories for runtime code.' },
        fast_path_roots:             { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Root directories eligible for fast path.' },
        fast_path_allowed_regexes:   { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Allowed file patterns for fast path.' },
        fast_path_sensitive_regexes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Sensitive file patterns that block fast path.' },
        sql_or_migration_regexes:    { type: 'array', items: { type: 'string', minLength: 1 }, description: 'SQL/migration file patterns.' },
        triggers: {
            type: 'object',
            description: 'Regex trigger patterns per review type.',
            additionalProperties: { type: 'array', items: { type: 'string', minLength: 1 } },
            minProperties: 1
        },
        code_like_regexes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Patterns matching code-like file extensions.' }
    },
    required: ['metrics_path', 'runtime_roots', 'fast_path_roots', 'triggers'],
    additionalProperties: true
});

export const outputFiltersSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/output-filters.schema.json',
    title: 'Output Filters',
    description: 'Gate output compression profiles, passthrough ceiling, and budget-adaptive tiers.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        passthrough_ceiling: {
            type: 'object',
            properties: {
                max_lines: { type: 'integer', minimum: 1 },
                strategy:  { type: 'string', minLength: 1 }
            },
            required: ['max_lines', 'strategy']
        },
        budget_profiles: {
            type: 'object',
            description: 'Token-budget-based adaptive filtering tiers.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable budget-adaptive filtering.' },
                tiers: {
                    type: 'array',
                    description: 'Ordered tiers; first tier whose max_tokens >= budget wins.',
                    items: {
                        type: 'object',
                        properties: {
                            label:                          { type: 'string', minLength: 1, description: 'Tier name (e.g. tight, moderate, generous).' },
                            max_tokens:                     { description: 'Upper token bound (positive integer); null = catch-all.' },
                            passthrough_ceiling_max_lines:  { type: 'integer', minimum: 1, description: 'Passthrough ceiling override.' },
                            fail_tail_lines:                { type: 'integer', minimum: 1, description: 'Failure tail lines override.' },
                            max_matches:                    { type: 'integer', minimum: 1, description: 'Parser max_matches override.' },
                            max_parser_lines:               { type: 'integer', minimum: 1, description: 'Parser max_lines override.' },
                            truncate_line_max_chars:         { type: 'integer', minimum: 1, description: 'Line truncation max_chars override.' }
                        },
                        required: ['label', 'max_tokens']
                    },
                    minItems: 1
                }
            },
            required: ['enabled', 'tiers']
        },
        profiles: {
            type: 'object',
            description: 'Named filter profiles.',
            additionalProperties: {
                type: 'object',
                properties: {
                    description:     { type: 'string', minLength: 1 },
                    emit_when_empty: { type: 'string' },
                    operations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type:        { type: 'string', minLength: 1 },
                                pattern:     { type: 'string' },
                                replacement: { type: 'string' },
                                suffix:      { type: 'string' },
                                max_chars:   { type: 'integer', minimum: 1 }
                            },
                            required: ['type']
                        }
                    },
                    parser: {
                        type: 'object',
                        properties: {
                            type:        { type: 'string', minLength: 1 },
                            max_matches: { type: 'integer', minimum: 1 },
                            max_lines:   { type: 'integer', minimum: 1 }
                        },
                        required: ['type']
                    }
                },
                required: ['description']
            },
            minProperties: 1
        }
    },
    required: ['version', 'profiles'],
    additionalProperties: true
});

export const skillPacksSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/skill-packs.schema.json',
    title: 'Skill Packs',
    description: 'Installed optional specialist skill packs.',
    type: 'object',
    properties: {
        version:          { type: 'integer', minimum: 1 },
        installed_packs:  { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true }
    },
    required: ['version', 'installed_packs'],
    additionalProperties: false
});

export const optionalSkillSelectionPolicySchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/optional-skill-selection-policy.schema.json',
    title: 'Optional Skill Selection Policy',
    description: 'Repo-local policy controlling preprompt-time optional skill selection.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        mode: {
            type: 'string',
            enum: ['off', 'advisory', 'required', 'strict']
        }
    },
    required: ['version', 'mode'],
    additionalProperties: false
});

export const isolationModeSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/isolation-mode.schema.json',
    title: 'Isolation Mode',
    description: 'Control-plane isolation and sandbox settings.',
    type: 'object',
    properties: {
        enabled:                             { type: 'boolean' },
        enforcement:                         { type: 'string', enum: ['STRICT', 'LOG_ONLY'] },
        require_manifest_match_before_task:  { type: 'boolean' },
        refuse_on_preflight_drift:           { type: 'boolean' },
        use_sandbox:                         { type: 'boolean' },
        same_user_limitation_notice:         { type: 'string' }
    },
    required: ['enabled', 'enforcement', 'require_manifest_match_before_task', 'refuse_on_preflight_drift', 'use_sandbox'],
    additionalProperties: false
});

export const REVIEW_ARTIFACT_RETENTION_MODES = ['none', 'summary', 'full'] as const;
export type ReviewArtifactRetentionMode = typeof REVIEW_ARTIFACT_RETENTION_MODES[number];

export const REVIEW_ARTIFACT_COMPRESSION_FORMATS = ['gzip'] as const;

export const reviewArtifactStorageSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/review-artifact-storage.schema.json',
    title: 'Review Artifact Storage',
    description: 'Retention modes and compression policy for review artifacts. Mode "none" reduces forensic reproducibility; mode "summary" keeps gate receipts only; mode "full" preserves everything subject to age/count retention.',
    type: 'object',
    properties: {
        version:               { type: 'integer', minimum: 1 },
        retention_mode:        { type: 'string', enum: [...REVIEW_ARTIFACT_RETENTION_MODES], description: 'Artifact retention: none = delete non-receipt artifacts, summary = keep gate receipts only, full = keep all.' },
        compress_after_days:   { type: 'integer', minimum: 0, description: 'Compress artifacts older than N days. 0 disables compression.' },
        compression_format:    { type: 'string', enum: [...REVIEW_ARTIFACT_COMPRESSION_FORMATS], description: 'Compression format for old artifacts.' },
        preserve_gate_receipts: { type: 'boolean', description: 'When true, gate receipt artifacts are never deleted regardless of retention_mode.' },
        gate_receipt_suffixes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'File suffixes that identify gate receipt artifacts.' },
        privacy_notice:        { type: 'string', description: 'Operator-facing notice explaining privacy/disk tradeoffs.' }
    },
    required: ['version', 'retention_mode', 'compress_after_days', 'compression_format', 'preserve_gate_receipts', 'gate_receipt_suffixes'],
    additionalProperties: false
});

export const OUT_OF_SCOPE_FAILURE_POLICIES = Object.freeze([
    'AUDIT_AND_BLOCK',
    'AUDIT_AND_WARN'
] as const);

export type OutOfScopeFailurePolicy = typeof OUT_OF_SCOPE_FAILURE_POLICIES[number];

export const workflowConfigSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/workflow-config.schema.json',
    title: 'Workflow Configuration',
    description: 'Optional workflow settings including post-task full-suite validation.',
    type: 'object',
    properties: {
        full_suite_validation: {
            type: 'object',
            description: 'Full-suite validation (complete test run after task review).',
            properties: {
                enabled:                    { type: 'boolean', description: 'Enable full-suite validation.' },
                command:                    { type: 'string', minLength: 1, description: 'Command to run for full-suite validation.' },
                timeout_ms:                 { type: 'integer', minimum: 1000, description: 'Timeout in milliseconds.' },
                green_summary_max_lines:    { type: 'integer', minimum: 1, description: 'Max lines for pass summary.' },
                red_failure_chunk_lines:    { type: 'integer', minimum: 10, description: 'Chunk size for failure output.' },
                out_of_scope_failure_policy: { type: 'string', enum: [...OUT_OF_SCOPE_FAILURE_POLICIES], description: 'Policy for handling out-of-scope failures.' },
                out_of_scope_failure_policies: { type: 'array', items: { type: 'string', enum: [...OUT_OF_SCOPE_FAILURE_POLICIES] }, uniqueItems: true, description: 'Available failure policies.' }
            },
            required: ['enabled', 'command', 'timeout_ms', 'green_summary_max_lines', 'red_failure_chunk_lines', 'out_of_scope_failure_policy']
        }
    },
    additionalProperties: false
});

const REVIEW_POLICY_VALUE = {
    description: 'Review toggle: true = always, false = never, "auto" = trigger-based.',
    oneOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['auto'] }
    ]
} as const;

const PROFILE_ENTRY_SCHEMA: Record<string, unknown> = Object.freeze({
    type: 'object',
    description: 'A single workspace profile defining policy overlays.',
    properties: {
        description: { type: 'string', minLength: 1, description: 'Human-readable profile description.' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Default task depth (1–3).' },
        review_policy: {
            type: 'object',
            description: 'Review type overrides.',
            properties: {
                code:     REVIEW_POLICY_VALUE,
                db:       REVIEW_POLICY_VALUE,
                security: REVIEW_POLICY_VALUE,
                refactor: REVIEW_POLICY_VALUE
            },
            additionalProperties: REVIEW_POLICY_VALUE
        },
        token_economy: {
            type: 'object',
            description: 'Token economy overrides.',
            properties: {
                enabled:                 { type: 'boolean' },
                strip_examples:          { type: 'boolean' },
                strip_code_blocks:       { type: 'boolean' },
                scoped_diffs:            { type: 'boolean' },
                compact_reviewer_output: { type: 'boolean' }
            },
            additionalProperties: false
        },
        skills: {
            type: 'object',
            description: 'Skill behaviour overrides.',
            properties: {
                auto_suggest: { type: 'boolean', description: 'Whether to auto-suggest skill packs for this profile.' }
            },
            additionalProperties: false
        }
    },
    required: ['description', 'depth', 'review_policy', 'token_economy', 'skills'],
    additionalProperties: false
});

export const profilesSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/profiles.schema.json',
    title: 'Workspace Profiles',
    description: 'Built-in and user-defined workspace profiles with an active-profile pointer.',
    type: 'object',
    properties: {
        version:          { type: 'integer', minimum: 1, description: 'Schema version.' },
        active_profile:   { type: 'string', minLength: 1, description: 'Name of the currently active profile.' },
        built_in_profiles: {
            type: 'object',
            description: 'Default built-in profiles shipped with the orchestrator. Protected from deletion by CLI commands.',
            additionalProperties: PROFILE_ENTRY_SCHEMA,
            minProperties: 1
        },
        user_profiles: {
            type: 'object',
            description: 'User-defined custom profiles.',
            additionalProperties: PROFILE_ENTRY_SCHEMA
        }
    },
    required: ['version', 'active_profile', 'built_in_profiles', 'user_profiles'],
    additionalProperties: false
});

// ---------------------------------------------------------------------------
// init-answers.json schema
// ---------------------------------------------------------------------------

const INIT_ANSWERS_BOOLEAN_LIKE = {
    type: 'string',
    description: 'Boolean-like value serialized as a string ("true" or "false").',
    enum: ['true', 'false']
} as const;

export const initAnswersSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/init-answers.schema.json',
    title: 'Init Answers',
    description: 'Portable schema for the init-answers.json configuration collected during workspace initialization.',
    type: 'object',
    properties: {
        AssistantLanguage: { type: 'string', minLength: 1, description: 'Natural language for assistant responses (e.g. "English").' },
        AssistantBrevity:  { type: 'string', enum: [...BREVITY_VALUES], description: 'Response brevity preference.' },
        SourceOfTruth:     { type: 'string', enum: [...SOURCE_OF_TRUTH_VALUES], description: 'Selected agent provider whose entrypoint file is the canonical source of truth.' },
        EnforceNoAutoCommit:        { ...INIT_ANSWERS_BOOLEAN_LIKE },
        ClaudeOrchestratorFullAccess: { ...INIT_ANSWERS_BOOLEAN_LIKE },
        TokenEconomyEnabled:        { ...INIT_ANSWERS_BOOLEAN_LIKE },
        ProviderMinimalism:         { ...INIT_ANSWERS_BOOLEAN_LIKE, description: 'When true (default), materialize only the canonical active provider entrypoint; additional providers require explicit ActiveAgentFiles.' },
        CollectedVia:      { type: 'string', enum: [...COLLECTED_VIA_VALUES], description: 'How the answers were collected.' },
        ActiveAgentFiles:  { type: 'string', minLength: 1, description: 'Comma-separated list of active canonical agent entrypoint files.' }
    },
    required: [
        'AssistantLanguage', 'AssistantBrevity', 'SourceOfTruth',
        'EnforceNoAutoCommit', 'ClaudeOrchestratorFullAccess', 'TokenEconomyEnabled',
        'CollectedVia'
    ],
    additionalProperties: false
});

// ---------------------------------------------------------------------------
// Root garda.config.json schema
// ---------------------------------------------------------------------------

export const gardaConfigSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/garda.config.schema.json',
    title: 'Garda Agent Orchestrator Configuration',
    description: 'Root configuration manifest referencing individual config files.',
    type: 'object',
    properties: {
        $schema: { type: 'string' },
        version: { type: 'integer', minimum: 1, description: 'Config schema version.' },
        configs: {
            type: 'object',
            description: 'Map from config name to relative path within the bundle config directory.',
            properties: {
                'review-capabilities': { type: 'string', minLength: 1 },
                'token-economy':       { type: 'string', minLength: 1 },
                paths:                 { type: 'string', minLength: 1 },
                'output-filters':      { type: 'string', minLength: 1 },
                'skill-packs':         { type: 'string', minLength: 1 },
                'optional-skill-selection-policy': { type: 'string', minLength: 1 },
                'isolation-mode':      { type: 'string', minLength: 1 },
                profiles:              { type: 'string', minLength: 1 },
                'review-artifact-storage': { type: 'string', minLength: 1 },
                'workflow-config':     { type: 'string', minLength: 1 }
            },
            required: [
                'review-capabilities', 'token-economy', 'paths',
                'output-filters', 'skill-packs', 'isolation-mode', 'profiles',
                'review-artifact-storage'
            ],
            additionalProperties: false
        }
    },
    required: ['version', 'configs'],
    additionalProperties: true
});

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

export interface ConfigSchemaEntry {
    name: string;
    schema: Record<string, unknown>;
    fileName: string;
}

const CONFIG_SCHEMAS: readonly ConfigSchemaEntry[] = Object.freeze([
    { name: 'review-capabilities', schema: reviewCapabilitiesSchema, fileName: 'review-capabilities.json' },
    { name: 'token-economy',       schema: tokenEconomySchema,       fileName: 'token-economy.json' },
    { name: 'paths',               schema: pathsSchema,              fileName: 'paths.json' },
    { name: 'output-filters',      schema: outputFiltersSchema,      fileName: 'output-filters.json' },
    { name: 'skill-packs',         schema: skillPacksSchema,         fileName: 'skill-packs.json' },
    { name: 'optional-skill-selection-policy', schema: optionalSkillSelectionPolicySchema, fileName: 'optional-skill-selection-policy.json' },
    { name: 'isolation-mode',      schema: isolationModeSchema,      fileName: 'isolation-mode.json' },
    { name: 'profiles',            schema: profilesSchema,           fileName: 'profiles.json' },
    { name: 'review-artifact-storage', schema: reviewArtifactStorageSchema, fileName: 'review-artifact-storage.json' },
    { name: 'workflow-config',     schema: workflowConfigSchema,     fileName: 'workflow-config.json' }
]);

const OPTIONAL_ROOT_CONFIG_NAMES = new Set<string>([
    'optional-skill-selection-policy',
    'workflow-config'
]);

export function getConfigSchemas(): readonly ConfigSchemaEntry[] {
    return CONFIG_SCHEMAS;
}

export function getConfigSchemaByName(name: string): ConfigSchemaEntry | undefined {
    return CONFIG_SCHEMAS.find((entry) => entry.name === name);
}

// ---------------------------------------------------------------------------
// Lightweight schema validation (no external dependency)
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
    path: string;
    message: string;
}

export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaValidationError[];
}

function validateType(value: unknown, expected: string, jsonPath: string): SchemaValidationError | null {
    if (expected === 'array') {
        return Array.isArray(value) ? null : { path: jsonPath, message: `Expected array, got ${typeof value}.` };
    }
    if (expected === 'integer') {
        return typeof value === 'number' && Number.isInteger(value)
            ? null
            : { path: jsonPath, message: `Expected integer, got ${typeof value}.` };
    }
    if (expected === 'object') {
        return (value !== null && typeof value === 'object' && !Array.isArray(value))
            ? null
            : { path: jsonPath, message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}.` };
    }
    return typeof value === expected ? null : { path: jsonPath, message: `Expected ${expected}, got ${typeof value}.` };
}

/**
 * Validates a JSON value against a JSON Schema subset (draft-07).
 *
 * Supports: type, required, properties, additionalProperties, items,
 * enum, minimum, minLength, minProperties, uniqueItems.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, rootPath = ''): SchemaValidationResult {
    const errors: SchemaValidationError[] = [];

    const schemaType = schema.type as string | undefined;
    if (schemaType) {
        const typeError = validateType(value, schemaType, rootPath || '$');
        if (typeError) {
            errors.push(typeError);
            return { valid: false, errors };
        }
    }

    if (schemaType === 'string') {
        const str = value as string;
        const minLength = schema.minLength as number | undefined;
        if (minLength !== undefined && str.length < minLength) {
            errors.push({ path: rootPath || '$', message: `String length ${str.length} < minimum ${minLength}.` });
        }
        const enumValues = schema.enum as string[] | undefined;
        if (enumValues && !enumValues.includes(str)) {
            errors.push({ path: rootPath || '$', message: `Value '${str}' not in enum [${enumValues.join(', ')}].` });
        }
    }

    if (schemaType === 'integer' || schemaType === 'number') {
        const num = value as number;
        const minimum = schema.minimum as number | undefined;
        if (minimum !== undefined && num < minimum) {
            errors.push({ path: rootPath || '$', message: `Value ${num} < minimum ${minimum}.` });
        }
    }

    if (schemaType === 'array' && Array.isArray(value)) {
        const itemsSchema = schema.items as Record<string, unknown> | undefined;
        if (itemsSchema) {
            for (let i = 0; i < value.length; i++) {
                const itemResult = validateAgainstSchema(value[i], itemsSchema, `${rootPath}[${i}]`);
                errors.push(...itemResult.errors);
            }
        }
        if (schema.uniqueItems === true) {
            const seen = new Set<string>();
            for (let i = 0; i < value.length; i++) {
                const serialized = JSON.stringify(value[i]);
                if (seen.has(serialized)) {
                    errors.push({ path: `${rootPath}[${i}]`, message: 'Duplicate item in array with uniqueItems constraint.' });
                }
                seen.add(serialized);
            }
        }
    }

    if (schemaType === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        const required = schema.required as string[] | undefined;
        const additionalProperties = schema.additionalProperties;

        if (required) {
            for (const key of required) {
                if (!(key in obj)) {
                    errors.push({ path: `${rootPath}.${key}`, message: `Required property '${key}' is missing.` });
                }
            }
        }

        if (properties) {
            for (const [key, propSchema] of Object.entries(properties)) {
                if (key in obj) {
                    const propResult = validateAgainstSchema(obj[key], propSchema, `${rootPath}.${key}`);
                    errors.push(...propResult.errors);
                }
            }
        }

        if (additionalProperties === false && properties) {
            const allowed = new Set(Object.keys(properties));
            for (const key of Object.keys(obj)) {
                if (!allowed.has(key)) {
                    errors.push({ path: `${rootPath}.${key}`, message: `Additional property '${key}' is not allowed.` });
                }
            }
        }

        if (typeof additionalProperties === 'object' && additionalProperties !== null) {
            const knownKeys = properties ? new Set(Object.keys(properties)) : new Set<string>();
            for (const [key, val] of Object.entries(obj)) {
                if (!knownKeys.has(key)) {
                    const addlResult = validateAgainstSchema(val, additionalProperties as Record<string, unknown>, `${rootPath}.${key}`);
                    errors.push(...addlResult.errors);
                }
            }
        }

        const minProperties = schema.minProperties as number | undefined;
        if (minProperties !== undefined && Object.keys(obj).length < minProperties) {
            errors.push({ path: rootPath || '$', message: `Object has ${Object.keys(obj).length} properties, minimum is ${minProperties}.` });
        }
    }

    return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Config-directory-level validation
// ---------------------------------------------------------------------------

export interface ConfigValidationReport {
    passed: boolean;
    rootConfigValid: boolean;
    rootConfigPath: string;
    rootErrors: string[];
    configs: ConfigFileReport[];
}

export interface ConfigFileReport {
    name: string;
    filePath: string;
    exists: boolean;
    parseable: boolean;
    schemaValid: boolean;
    runtimeValid: boolean;
    errors: string[];
}

/**
 * Validate all config files in a live config directory against their JSON
 * Schemas and runtime validators.
 *
 * @param bundleRoot Absolute path to the orchestrator bundle root
 *   (e.g. `<repo>/garda-agent-orchestrator`).
 * @param runtimeValidators Optional map of runtime validator functions keyed
 *   by config name. Defaults to the managed-config validators from
 *   `config-artifacts.ts`.
 */
export function validateAllConfigs(
    bundleRoot: string,
    runtimeValidators?: Record<string, (input: unknown) => Record<string, unknown>>
): ConfigValidationReport {
    const configDir = path.join(bundleRoot, 'live', 'config');
    const rootConfigPath = path.join(configDir, 'garda.config.json');

    let rootConfigValid = false;
    const rootErrors: string[] = [];
    let rootConfigMap: Record<string, string> | null = null;

    try {
        const raw = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8'));
        const rootData = ensurePlainObject(raw, 'garda.config.json');
        const schemaResult = validateAgainstSchema(rootData, gardaConfigSchema as Record<string, unknown>);
        if (!schemaResult.valid) {
            for (const err of schemaResult.errors) {
                rootErrors.push(`${err.path}: ${err.message}`);
            }
        } else {
            rootConfigValid = true;
            rootConfigMap = getRootConfigMap(rootData);
        }
    } catch (err) {
        rootErrors.push(String((err as Error).message));
    }

    const configs: ConfigFileReport[] = [];
    let allPassed = rootConfigValid;

    const validators = runtimeValidators ?? getManagedValidators();

    if (!rootConfigValid || !rootConfigMap) {
        return {
            passed: false,
            rootConfigValid,
            rootConfigPath,
            rootErrors,
            configs
        };
    }

    for (const entry of CONFIG_SCHEMAS) {
        const configuredRelativePath = rootConfigMap[entry.name];
        if (!configuredRelativePath) {
            continue;
        }
        const filePath = resolveManifestConfigPath(configDir, rootConfigMap[entry.name]);
        const report: ConfigFileReport = {
            name: entry.name,
            filePath: filePath ?? path.join(configDir, configuredRelativePath),
            exists: false,
            parseable: false,
            schemaValid: false,
            runtimeValid: false,
            errors: []
        };

        try {
            if (!filePath) {
                report.errors.push(`manifest: '${configuredRelativePath}' must resolve inside live/config.`);
                configs.push(report);
                allPassed = false;
                continue;
            }
            if (!fs.existsSync(filePath)) {
                report.errors.push('File not found.');
                configs.push(report);
                allPassed = false;
                continue;
            }
            report.exists = true;

            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            report.parseable = true;

            const schemaResult = validateAgainstSchema(raw, entry.schema as Record<string, unknown>);
            if (schemaResult.valid) {
                report.schemaValid = true;
            } else {
                for (const err of schemaResult.errors) {
                    report.errors.push(`schema: ${err.path}: ${err.message}`);
                }
            }

            const runtimeValidator = validators[entry.name];
            if (runtimeValidator) {
                try {
                    runtimeValidator(raw);
                    report.runtimeValid = true;
                } catch (runtimeErr) {
                    report.errors.push(`runtime: ${(runtimeErr as Error).message}`);
                }
            } else {
                report.runtimeValid = true;
            }
        } catch (err) {
            report.errors.push(`parse: ${(err as Error).message}`);
        }

        if (!report.schemaValid || !report.runtimeValid) {
            allPassed = false;
        }

        configs.push(report);
    }

    return {
        passed: allPassed,
        rootConfigValid,
        rootConfigPath,
        rootErrors,
        configs
    };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatValidationReport(report: ConfigValidationReport): string {
    const lines: string[] = [];
    lines.push(report.passed ? 'CONFIG_VALIDATION_PASSED' : 'CONFIG_VALIDATION_FAILED');
    lines.push(`RootConfig: ${report.rootConfigValid ? 'valid' : 'INVALID'} (${report.rootConfigPath})`);
    for (const err of report.rootErrors) {
        lines.push(`  root: ${err}`);
    }

    for (const cfg of report.configs) {
        const status = cfg.exists
            ? (cfg.schemaValid && cfg.runtimeValid ? 'PASS' : 'FAIL')
            : 'MISSING';
        lines.push(`  ${cfg.name}: ${status}`);
        for (const err of cfg.errors) {
            lines.push(`    - ${err}`);
        }
    }

    return lines.join('\n');
}

export function formatValidationReportCompact(report: ConfigValidationReport): string {
    const passCount = report.configs.filter((c) => c.schemaValid && c.runtimeValid).length;
    return `${report.passed ? 'CONFIG_VALIDATION_PASSED' : 'CONFIG_VALIDATION_FAILED'}: ${passCount}/${report.configs.length} configs valid, root=${report.rootConfigValid ? 'ok' : 'INVALID'}, root_errors=${report.rootErrors.length}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getManagedValidators(): Record<string, (input: unknown) => Record<string, unknown>> {
    return getManagedConfigValidators() as Record<string, (input: unknown) => Record<string, unknown>>;
}

function getRootConfigMap(rootData: Record<string, unknown>): Record<string, string> {
    const rawConfigs = ensurePlainObject(rootData.configs, 'garda.config.json.configs');
    const map: Record<string, string> = {};

    for (const entry of CONFIG_SCHEMAS) {
        const relativePath = rawConfigs[entry.name];
        if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
            if (OPTIONAL_ROOT_CONFIG_NAMES.has(entry.name)) {
                continue;
            }
            throw new Error(`garda.config.json.configs.${entry.name} must be a non-empty string.`);
        }
        map[entry.name] = relativePath.trim();
    }

    return map;
}

function resolveManifestConfigPath(configDir: string, relativePath: string): string | null {
    const resolvedPath = path.resolve(configDir, relativePath);
    const relativeToConfigDir = path.relative(configDir, resolvedPath);
    if (relativeToConfigDir.startsWith('..') || path.isAbsolute(relativeToConfigDir)) {
        return null;
    }
    return resolvedPath;
}
