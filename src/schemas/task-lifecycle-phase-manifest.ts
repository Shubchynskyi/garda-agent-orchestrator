export const TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const TASK_LIFECYCLE_PHASE_IDS = Object.freeze([
    'startup',
    'preflight',
    'implementation',
    'validation',
    'review',
    'closeout',
    'terminal'
] as const);

export type TaskLifecyclePhaseId = (typeof TASK_LIFECYCLE_PHASE_IDS)[number];

export const TASK_LIFECYCLE_PREDICATE_IDS = Object.freeze([
    'changes_exist',
    'optional_quality_checks_enabled',
    'reviews_required',
    'review_gate_required',
    'full_suite_after_compile_before_reviews',
    'full_suite_before_review_checkpoint',
    'full_suite_before_completion',
    'project_memory_impact_required',
    'completion_passed',
    'committable_changes_exist'
] as const);

export type TaskLifecyclePredicateId = (typeof TASK_LIFECYCLE_PREDICATE_IDS)[number];

export type TaskLifecycleCondition =
    | { readonly kind: 'always' }
    | { readonly kind: 'predicate'; readonly predicate_id: TaskLifecyclePredicateId };

export interface TaskLifecycleMandatoryGate {
    readonly gate_id: string;
    readonly condition: TaskLifecycleCondition;
}

export interface TaskLifecycleOpaqueReviewExtension {
    readonly kind: 'opaque';
    readonly owner: 'review-subsystem';
    readonly contract_id: 'task-review-phase';
    readonly payload?: unknown;
}

export interface TaskLifecyclePhaseDefinition {
    readonly id: TaskLifecyclePhaseId;
    readonly condition: TaskLifecycleCondition;
    readonly mandatory_gates: readonly TaskLifecycleMandatoryGate[];
    readonly extension?: TaskLifecycleOpaqueReviewExtension;
}

export interface TaskLifecycleRecommendedCommand {
    readonly command_id: string;
    readonly condition: TaskLifecycleCondition;
}

export interface TaskLifecyclePhaseManifest {
    readonly schema_version: typeof TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION;
    readonly stages: readonly TaskLifecyclePhaseDefinition[];
    readonly recommended_post_closeout_commands: readonly TaskLifecycleRecommendedCommand[];
}

const CONDITION_SCHEMA = Object.freeze({
    oneOf: [
        {
            type: 'object',
            properties: { kind: { const: 'always' } },
            required: ['kind'],
            additionalProperties: false
        },
        {
            type: 'object',
            properties: {
                kind: { const: 'predicate' },
                predicate_id: { enum: [...TASK_LIFECYCLE_PREDICATE_IDS] }
            },
            required: ['kind', 'predicate_id'],
            additionalProperties: false
        }
    ]
});

const MANDATORY_GATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        gate_id: { type: 'string', minLength: 1 },
        condition: CONDITION_SCHEMA
    },
    required: ['gate_id', 'condition'],
    additionalProperties: false
});

const REVIEW_EXTENSION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        kind: { const: 'opaque' },
        owner: { const: 'review-subsystem' },
        contract_id: { const: 'task-review-phase' },
        payload: {}
    },
    required: ['kind', 'owner', 'contract_id'],
    additionalProperties: false
});

function createStageSchema(id: TaskLifecyclePhaseId): Record<string, unknown> {
    const reviewStage = id === 'review';
    return Object.freeze({
        type: 'object',
        properties: {
            id: { const: id },
            condition: CONDITION_SCHEMA,
            mandatory_gates: {
                type: 'array',
                items: MANDATORY_GATE_SCHEMA
            },
            ...(reviewStage ? { extension: REVIEW_EXTENSION_SCHEMA } : {})
        },
        required: [
            'id',
            'condition',
            'mandatory_gates',
            ...(reviewStage ? ['extension'] : [])
        ],
        additionalProperties: false
    });
}

const STAGE_SCHEMAS = Object.freeze(TASK_LIFECYCLE_PHASE_IDS.map(createStageSchema));

export const taskLifecyclePhaseManifestSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/task-lifecycle-phase-manifest.schema.json',
    title: 'Task Lifecycle Phase Manifest',
    description: 'Canonical top-level task lifecycle order and gate requirements.',
    type: 'object',
    properties: {
        schema_version: { const: TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION },
        stages: {
            type: 'array',
            minItems: TASK_LIFECYCLE_PHASE_IDS.length,
            maxItems: TASK_LIFECYCLE_PHASE_IDS.length,
            items: STAGE_SCHEMAS,
            additionalItems: false
        },
        recommended_post_closeout_commands: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {
                    command_id: { type: 'string', minLength: 1 },
                    condition: CONDITION_SCHEMA
                },
                required: ['command_id', 'condition'],
                additionalProperties: false
            }
        }
    },
    required: ['schema_version', 'stages', 'recommended_post_closeout_commands'],
    additionalProperties: false
});

const ROOT_KEYS = new Set(['schema_version', 'stages', 'recommended_post_closeout_commands']);
const STAGE_KEYS = new Set(['id', 'condition', 'mandatory_gates', 'extension']);
const GATE_KEYS = new Set(['gate_id', 'condition']);
const CONDITION_KEYS = new Set(['kind', 'predicate_id']);
const EXTENSION_KEYS = new Set(['kind', 'owner', 'contract_id', 'payload']);
const COMMAND_KEYS = new Set(['command_id', 'condition']);
const STABLE_ID_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/u;

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            throw new Error(`${label}.${key} is not supported.`);
        }
    }
}

function normalizeStableId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase stable id.`);
    }
    return value;
}

function normalizeCondition(value: unknown, label: string): TaskLifecycleCondition {
    const raw = ensureRecord(value, label);
    assertKnownKeys(raw, CONDITION_KEYS, label);
    if (raw.kind === 'always') {
        if (raw.predicate_id !== undefined) {
            throw new Error(`${label}.predicate_id is not allowed for an always condition.`);
        }
        return Object.freeze({ kind: 'always' });
    }
    if (raw.kind !== 'predicate') {
        throw new Error(`${label}.kind must be always or predicate.`);
    }
    if (!TASK_LIFECYCLE_PREDICATE_IDS.includes(raw.predicate_id as TaskLifecyclePredicateId)) {
        throw new Error(`${label}.predicate_id is not a supported lifecycle predicate.`);
    }
    return Object.freeze({ kind: 'predicate', predicate_id: raw.predicate_id as TaskLifecyclePredicateId });
}

function normalizeGate(value: unknown, label: string): TaskLifecycleMandatoryGate {
    const raw = ensureRecord(value, label);
    assertKnownKeys(raw, GATE_KEYS, label);
    return Object.freeze({
        gate_id: normalizeStableId(raw.gate_id, `${label}.gate_id`),
        condition: normalizeCondition(raw.condition, `${label}.condition`)
    });
}

function normalizeReviewExtension(value: unknown, label: string): TaskLifecycleOpaqueReviewExtension {
    const raw = ensureRecord(value, label);
    assertKnownKeys(raw, EXTENSION_KEYS, label);
    if (raw.kind !== 'opaque' || raw.owner !== 'review-subsystem' || raw.contract_id !== 'task-review-phase') {
        throw new Error(`${label} must be the opaque task-review-phase contract owned by review-subsystem.`);
    }
    const extension: TaskLifecycleOpaqueReviewExtension = {
        kind: 'opaque',
        owner: 'review-subsystem',
        contract_id: 'task-review-phase'
    };
    if (Object.hasOwn(raw, 'payload')) {
        return Object.freeze({ ...extension, payload: raw.payload });
    }
    return Object.freeze(extension);
}

function normalizeStage(value: unknown, index: number): TaskLifecyclePhaseDefinition {
    const label = `stages[${index}]`;
    const raw = ensureRecord(value, label);
    assertKnownKeys(raw, STAGE_KEYS, label);
    const expectedId = TASK_LIFECYCLE_PHASE_IDS[index];
    if (raw.id !== expectedId) {
        throw new Error(`${label}.id must be '${expectedId}' to preserve canonical lifecycle order.`);
    }
    if (!Array.isArray(raw.mandatory_gates)) {
        throw new Error(`${label}.mandatory_gates must be an array.`);
    }
    const mandatoryGates = raw.mandatory_gates.map((gate, gateIndex) => (
        normalizeGate(gate, `${label}.mandatory_gates[${gateIndex}]`)
    ));
    const gateIds = mandatoryGates.map((gate) => gate.gate_id);
    if (new Set(gateIds).size !== gateIds.length) {
        throw new Error(`${label}.mandatory_gates must not contain duplicate gate ids.`);
    }
    const stage: TaskLifecyclePhaseDefinition = {
        id: expectedId,
        condition: normalizeCondition(raw.condition, `${label}.condition`),
        mandatory_gates: Object.freeze(mandatoryGates)
    };
    if (expectedId === 'review') {
        if (raw.extension === undefined) {
            throw new Error(`${label}.extension is required for the review phase.`);
        }
        return Object.freeze({
            ...stage,
            extension: normalizeReviewExtension(raw.extension, `${label}.extension`)
        });
    } else if (raw.extension !== undefined) {
        throw new Error(`${label}.extension is only supported for the review phase.`);
    }
    return Object.freeze(stage);
}

function normalizeRecommendedCommand(value: unknown, index: number): TaskLifecycleRecommendedCommand {
    const label = `recommended_post_closeout_commands[${index}]`;
    const raw = ensureRecord(value, label);
    assertKnownKeys(raw, COMMAND_KEYS, label);
    return Object.freeze({
        command_id: normalizeStableId(raw.command_id, `${label}.command_id`),
        condition: normalizeCondition(raw.condition, `${label}.condition`)
    });
}

export function validateTaskLifecyclePhaseManifest(value: unknown): TaskLifecyclePhaseManifest {
    const raw = ensureRecord(value, 'task-lifecycle phase manifest');
    assertKnownKeys(raw, ROOT_KEYS, 'task-lifecycle phase manifest');
    if (raw.schema_version !== TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION) {
        throw new Error(`task-lifecycle phase manifest schema_version must be ${TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION}.`);
    }
    if (!Array.isArray(raw.stages) || raw.stages.length !== TASK_LIFECYCLE_PHASE_IDS.length) {
        throw new Error(`stages must contain exactly ${TASK_LIFECYCLE_PHASE_IDS.length} canonical lifecycle phases.`);
    }
    if (!Array.isArray(raw.recommended_post_closeout_commands) || raw.recommended_post_closeout_commands.length === 0) {
        throw new Error('recommended_post_closeout_commands must be a non-empty array.');
    }
    const stages = raw.stages.map(normalizeStage);
    const commands = raw.recommended_post_closeout_commands.map(normalizeRecommendedCommand);
    const commandIds = commands.map((command) => command.command_id);
    if (new Set(commandIds).size !== commandIds.length) {
        throw new Error('recommended_post_closeout_commands must not contain duplicate command ids.');
    }
    return Object.freeze({
        schema_version: TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION,
        stages: Object.freeze(stages),
        recommended_post_closeout_commands: Object.freeze(commands)
    });
}

const ALWAYS = Object.freeze({ kind: 'always' } as const);
const when = (predicate_id: TaskLifecyclePredicateId): TaskLifecycleCondition => (
    Object.freeze({ kind: 'predicate', predicate_id })
);
const gate = (gate_id: string, condition: TaskLifecycleCondition = ALWAYS): TaskLifecycleMandatoryGate => (
    Object.freeze({ gate_id, condition })
);

export const TASK_LIFECYCLE_PHASE_MANIFEST = validateTaskLifecyclePhaseManifest({
    schema_version: TASK_LIFECYCLE_PHASE_MANIFEST_SCHEMA_VERSION,
    stages: [
        {
            id: 'startup',
            condition: ALWAYS,
            mandatory_gates: [
                gate('enter-task-mode'),
                gate('load-rule-pack:task-entry'),
                gate('handshake-diagnostics'),
                gate('shell-smoke-preflight')
            ]
        },
        {
            id: 'preflight',
            condition: ALWAYS,
            mandatory_gates: [
                gate('classify-change'),
                gate('load-rule-pack:post-preflight')
            ]
        },
        {
            id: 'implementation',
            condition: when('changes_exist'),
            mandatory_gates: []
        },
        {
            id: 'validation',
            condition: when('changes_exist'),
            mandatory_gates: [
                gate('optional-quality-checklist', when('optional_quality_checks_enabled')),
                gate('compile-gate'),
                gate('full-suite-validation', when('full_suite_after_compile_before_reviews'))
            ]
        },
        {
            id: 'review',
            condition: when('reviews_required'),
            mandatory_gates: [
                gate('full-suite-validation', when('full_suite_before_review_checkpoint'))
            ],
            extension: {
                kind: 'opaque',
                owner: 'review-subsystem',
                contract_id: 'task-review-phase'
            }
        },
        {
            id: 'closeout',
            condition: ALWAYS,
            mandatory_gates: [
                gate('required-reviews-check', when('review_gate_required')),
                gate('full-suite-validation', when('full_suite_before_completion')),
                gate('project-memory-impact', when('project_memory_impact_required')),
                gate('doc-impact-gate')
            ]
        },
        {
            id: 'terminal',
            condition: ALWAYS,
            mandatory_gates: [gate('completion-gate')]
        }
    ],
    recommended_post_closeout_commands: [
        { command_id: 'task-audit-summary', condition: when('completion_passed') },
        { command_id: 'human-commit', condition: when('committable_changes_exist') }
    ]
});
