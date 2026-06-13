/**
 * Portable JSON Schema definitions for all managed config files.
 *
 * Each schema is a plain object following the JSON Schema draft-07 spec.
 * Schemas can be serialized to `.json` for external tooling or used in-process
 * for programmatic validation via {@link validateAgainstSchema}.
 */

import {
    SOURCE_OF_TRUTH_VALUES,
    BREVITY_VALUES,
    COLLECTED_VIA_VALUES
} from '../core/constants';
import { REVIEW_EXECUTION_POLICY_MODES } from '../core/review-execution-policy';
import {
    FULL_SUITE_VALIDATION_PLACEMENTS,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES
} from '../core/workflow-config';

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
        ordinary_doc_paths:          { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Relative file paths or globs for ordinary documents that may skip code/test review while still remaining auditable.' },
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

export const runtimeRetentionSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/runtime-retention.schema.json',
    title: 'Runtime Retention Policy',
    description: 'Tiered retention defaults for active evidence, healthy DONE compaction, problem-task compression, purge safety, and future daily maintenance.',
    type: 'object',
    properties: {
        version: { type: 'integer', minimum: 1 },
        active_tasks: {
            type: 'object',
            properties: {
                protect_runtime_grace_days: { type: 'integer', minimum: 0 },
                protect_current_cycle_artifacts: { type: 'boolean' }
            },
            required: ['protect_runtime_grace_days', 'protect_current_cycle_artifacts'],
            additionalProperties: false
        },
        healthy_done: {
            type: 'object',
            properties: {
                compact_after_days: { type: 'integer', minimum: 0 },
                require_ledger: { type: 'boolean' },
                retain_task_events_until_ledger_verified: { type: 'boolean' }
            },
            required: ['compact_after_days', 'require_ledger', 'retain_task_events_until_ledger_verified'],
            additionalProperties: false
        },
        problem_tasks: {
            type: 'object',
            properties: {
                compress_after_days: { type: 'integer', minimum: 0 },
                preserve_detailed_evidence: { type: 'boolean' }
            },
            required: ['compress_after_days', 'preserve_detailed_evidence'],
            additionalProperties: false
        },
        purge: {
            type: 'object',
            properties: {
                require_confirm: { type: 'boolean' }
            },
            required: ['require_confirm'],
            additionalProperties: false
        },
        daily_maintenance: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                max_tasks_per_run: { type: 'integer', minimum: 1 },
                eligible_older_than_days: { type: 'integer', minimum: 0 },
                keep_latest_tasks: { type: 'integer', minimum: 0 },
                dry_run: { type: 'boolean' }
            },
            required: ['enabled', 'max_tasks_per_run'],
            additionalProperties: false
        }
    },
    required: ['version', 'active_tasks', 'healthy_done', 'problem_tasks', 'purge', 'daily_maintenance'],
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
    description: 'Optional workflow settings including compile-gate command selection, post-task full-suite validation, project-memory maintenance, and guarded task reset.',
    type: 'object',
    properties: {
        compile_gate: {
            type: 'object',
            description: 'Compile-gate validation command. When unconfigured or omitted, compile-gate falls back to the legacy 40-commands.md command block.',
            properties: {
                command: { type: 'string', minLength: 1, description: 'Command to run for compile-gate validation.' }
            },
            required: ['command'],
            additionalProperties: false
        },
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
                placement: { type: 'string', enum: [...FULL_SUITE_VALIDATION_PLACEMENTS], description: 'Lifecycle point where enabled full-suite validation should run.' },
                out_of_scope_failure_policies: { type: 'array', items: { type: 'string', enum: [...OUT_OF_SCOPE_FAILURE_POLICIES] }, uniqueItems: true, description: 'Available failure policies.' }
            },
            required: ['enabled', 'command', 'timeout_ms', 'green_summary_max_lines', 'red_failure_chunk_lines', 'out_of_scope_failure_policy']
        },
        review_execution_policy: {
            type: 'object',
            description: 'Repo-local launch ordering policy for current-cycle review preparation and downstream dependency invalidation.',
            properties: {
                mode: {
                    type: 'string',
                    enum: [...REVIEW_EXECUTION_POLICY_MODES],
                    description: 'Review execution policy mode.'
                }
            },
            required: ['mode'],
            additionalProperties: false
        },
        scope_budget_guard: {
            type: 'object',
            description: 'Configurable guard that blocks oversized task scopes before compile/review loops.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable scope budget checks.' },
                profiles: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    minItems: 1,
                    uniqueItems: true,
                    description: 'Profiles where the guard applies.'
                },
                action: {
                    type: 'string',
                    enum: ['BLOCK_FOR_SPLIT', 'WARN_ONLY'],
                    description: 'Action when any configured budget is exceeded.'
                },
                max_files: { type: 'integer', minimum: 1, description: 'Maximum changed files before guard action.' },
                max_changed_lines: { type: 'integer', minimum: 1, description: 'Maximum changed lines before guard action.' },
                max_required_reviews: { type: 'integer', minimum: 1, description: 'Maximum required review lanes before guard action.' },
                max_review_tokens: { type: 'integer', minimum: 1, description: 'Maximum estimated review tokens before guard action.' }
            },
            required: ['enabled', 'profiles', 'action', 'max_files', 'max_changed_lines', 'max_required_reviews', 'max_review_tokens'],
            additionalProperties: false
        },
        review_cycle_guard: {
            type: 'object',
            description: 'Configurable guard that blocks runaway non-test review cycles.',
            properties: {
                enabled: { type: 'boolean', description: 'Enable review-cycle checks.' },
                action: {
                    type: 'string',
                    enum: ['BLOCK_FOR_OPERATOR_DECISION', 'WARN_ONLY'],
                    description: 'Action when any configured review-cycle limit is exceeded.'
                },
                max_failed_non_test_reviews: { type: 'integer', minimum: 1, description: 'Maximum failed non-test review attempts before guard action.' },
                max_total_non_test_reviews: { type: 'integer', minimum: 1, description: 'Maximum total non-test review attempts before guard action.' },
                excluded_review_types: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    minItems: 1,
                    uniqueItems: true,
                    description: 'Review types excluded from review-cycle counting.'
                },
                auto_split_enabled: {
                    type: 'boolean',
                    description: 'When true, next-step emits an auto-split instruction artifact instead of waiting for operator input after a review-cycle block.'
                }
            },
            required: ['enabled', 'action', 'max_failed_non_test_reviews', 'max_total_non_test_reviews', 'excluded_review_types'],
            additionalProperties: false
        },
        project_memory_maintenance: {
            type: 'object',
            description: 'Repo-local project-memory maintenance settings. Fresh workspaces default to update mode while explicit existing choices are preserved.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable project-memory maintenance checks.'
                },
                mode: {
                    type: 'string',
                    enum: [...PROJECT_MEMORY_MAINTENANCE_MODES],
                    description: 'Maintenance mode: off, check, update, or strict.'
                },
                run_before_final_closeout: {
                    type: 'boolean',
                    description: 'Run memory impact checks before final closeout when supported by task flow.'
                },
                require_user_approval_for_writes: {
                    type: 'boolean',
                    description: 'Require explicit operator approval before agent writes user-owned memory files.'
                },
                max_compact_summary_chars: {
                    type: 'integer',
                    minimum: 2000,
                    description: 'Maximum allowed characters in project-memory/compact.md.'
                },
                read_strategy: {
                    type: 'string',
                    enum: [...PROJECT_MEMORY_READ_STRATEGIES],
                    description: 'Project-memory read strategy. The current strategy requires README.md, then compact.md, then focused files.'
                },
                impact_artifact_retention_days: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Days to retain future project-memory impact artifacts.'
                }
            },
            required: [
                'enabled',
                'mode',
                'run_before_final_closeout',
                'require_user_approval_for_writes',
                'max_compact_summary_chars',
                'read_strategy',
                'impact_artifact_retention_days'
            ],
            additionalProperties: false
        },
        task_reset: {
            type: 'object',
            description: 'Guarded task-reset availability. Real reset mutations are disabled by default and require audited repo-local opt-in.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable confirmed task-reset mutations for this repository.'
                }
            },
            required: ['enabled'],
            additionalProperties: false
        },
        auto_backup: {
            type: 'object',
            description: 'Scheduled backup maintenance settings. Disabled by default and executed only through the daily maintenance trigger.',
            properties: {
                enabled: {
                    type: 'boolean',
                    description: 'Enable scheduled auto-backups.'
                },
                interval_days: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Minimum number of days between successful scheduled backups.'
                },
                keep_latest: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Number of latest backups to retain after scheduled backup creation.'
                }
            },
            required: ['enabled', 'interval_days', 'keep_latest'],
            additionalProperties: false
        },
        orchestrator_work_policy: {
            type: 'object',
            description: 'Workspace self-guard policy for agent-entered protected orchestrator work.',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['deny_agent_entry', 'require_operator_confirmation'],
                    description: 'deny_agent_entry blocks agent self-escalation into --orchestrator-work; require_operator_confirmation preserves source-checkout confirmation behavior.'
                }
            },
            required: ['mode'],
            additionalProperties: false
        }
    },
    additionalProperties: true
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
                'runtime-retention':   { type: 'string', minLength: 1 },
                'workflow-config':     { type: 'string', minLength: 1 }
            },
            required: [
                'review-capabilities', 'token-economy', 'paths',
                'output-filters', 'skill-packs', 'isolation-mode', 'profiles',
                'review-artifact-storage', 'runtime-retention'
            ],
            additionalProperties: false
        }
    },
    required: ['version', 'configs'],
    additionalProperties: true
});

export interface ConfigSchemaEntry {
    name: string;
    schema: Record<string, unknown>;
    fileName: string;
}

export const CONFIG_SCHEMAS: readonly ConfigSchemaEntry[] = Object.freeze([
    { name: 'review-capabilities', schema: reviewCapabilitiesSchema, fileName: 'review-capabilities.json' },
    { name: 'token-economy',       schema: tokenEconomySchema,       fileName: 'token-economy.json' },
    { name: 'paths',               schema: pathsSchema,              fileName: 'paths.json' },
    { name: 'output-filters',      schema: outputFiltersSchema,      fileName: 'output-filters.json' },
    { name: 'skill-packs',         schema: skillPacksSchema,         fileName: 'skill-packs.json' },
    { name: 'optional-skill-selection-policy', schema: optionalSkillSelectionPolicySchema, fileName: 'optional-skill-selection-policy.json' },
    { name: 'isolation-mode',      schema: isolationModeSchema,      fileName: 'isolation-mode.json' },
    { name: 'profiles',            schema: profilesSchema,           fileName: 'profiles.json' },
    { name: 'review-artifact-storage', schema: reviewArtifactStorageSchema, fileName: 'review-artifact-storage.json' },
    { name: 'runtime-retention',   schema: runtimeRetentionSchema,   fileName: 'runtime-retention.json' },
    { name: 'workflow-config',     schema: workflowConfigSchema,     fileName: 'workflow-config.json' }
]);

export const OPTIONAL_ROOT_CONFIG_NAMES = new Set<string>([
    'optional-skill-selection-policy',
    'workflow-config'
]);

export function getConfigSchemas(): readonly ConfigSchemaEntry[] {
    return CONFIG_SCHEMAS;
}

export function getConfigSchemaByName(name: string): ConfigSchemaEntry | undefined {
    return CONFIG_SCHEMAS.find((entry) => entry.name === name);
}
