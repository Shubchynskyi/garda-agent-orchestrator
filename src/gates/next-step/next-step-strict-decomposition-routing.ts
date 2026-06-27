import {
    getStrictDecompositionDecisionEvidence,
    type StrictDecompositionDecisionEvidenceResult
} from '../task-mode/strict-decomposition-decision';
import {
    transitionStrictDecompositionParentToDecomposed
} from './next-step-task-queue-transitions';
import {
    formatStrictDecompositionSplitRoutingViolations,
    resolveStrictDecompositionSplitRoutingState,
    type TaskQueueEntry
} from './next-step-task-queue';
import {
    resolveStrictDecompositionSplitTerminalRoute
} from './next-step-terminal-status-routing';
import {
    buildCommand,
    formatNextStepInlineList,
    formatNextStepInlineValue,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    getPreflightChangedFiles
} from './next-step-doc-closeout-readiness';
import {
    getStringField
} from './next-step-lifecycle-command-builders';
import type {
    NextStepArtifactState,
    NextStepCommand,
    NextStepProfileSummary,
    NextStepStatus
} from './next-step';

const STRICT_DECOMPOSITION_STRONG_RISK_TERMS = Object.freeze([
    'strict-decomposition',
    'decomposition',
    'decompose',
    'split-required',
    'split required',
    'scope-budget',
    'review-cycle',
    'umbrella',
    'parent-derived',
    'next-step',
    'large strict',
    'broad strict'
]);
const STRICT_DECOMPOSITION_LOW_RISK_TERMS = Object.freeze([
    'tiny',
    'small',
    'local',
    'one-line',
    'single file',
    'typo',
    'wording',
    'copy'
]);
const STRICT_DECOMPOSITION_BROAD_DOMAIN_TERMS = Object.freeze([
    { key: 'api', aliases: ['api'] },
    { key: 'audit', aliases: ['audit', 'audits'] },
    { key: 'backup', aliases: ['backup', 'backups'] },
    { key: 'checks', aliases: ['checks', 'validation', 'validations'] },
    { key: 'config', aliases: ['config', 'configuration', 'settings'] },
    { key: 'docs', aliases: ['docs', 'documentation', 'changelog'] },
    { key: 'full-suite', aliases: ['full-suite', 'full suite', 'full tests'] },
    { key: 'i18n', aliases: ['i18n', 'translation', 'translations', 'localization', 'language pack'] },
    { key: 'init', aliases: ['init', 'setup', 'materialization'] },
    { key: 'memory', aliases: ['memory', 'project memory'] },
    { key: 'protected', aliases: ['protected', 'control-plane'] },
    { key: 'reset', aliases: ['reset', 'task reset', 'discard'] },
    { key: 'review', aliases: ['review', 'reviews', 'reviewer'] },
    { key: 'ui', aliases: ['ui', 'dashboard', 'report', 'reports'] },
    { key: 'workflow', aliases: ['workflow', 'gate', 'gates', 'next step'] }
]);
const STRICT_DECOMPOSITION_CHANGED_FILE_THRESHOLD = 3;
const STRICT_DECOMPOSITION_CHANGED_LINE_THRESHOLD = 120;
const STRICT_DECOMPOSITION_REVIEW_COUNT_THRESHOLD = 2;
const STRICT_DECOMPOSITION_BROAD_DOMAIN_THRESHOLD = 3;

export interface StrictDecompositionDecisionRequirement {
    required: boolean;
    taskSummary: string;
    riskSignals: string[];
}

export interface NextStepStrictDecompositionRoute {
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts?: NextStepArtifactState[];
    presentArtifacts?: NextStepArtifactState[];
    finalReport?: null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function normalizeStrictDecompositionSearchText(...values: Array<string | null | undefined>): string {
    return values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .join(' ');
}

function containsStrictDecompositionTerm(text: string, term: string): boolean {
    return text.includes(term);
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStrictDecompositionDelimitedTerm(text: string, term: string): boolean {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`).test(text);
}

function containsStrictDecompositionBroadAlias(text: string, alias: string): boolean {
    return containsStrictDecompositionDelimitedTerm(text, alias);
}

function getStrictDecompositionDecisionTaskSummary(
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): string {
    return getStringField(taskMode, 'task_summary', taskEntry?.title || taskId);
}

function isStrictProfileSelected(
    taskEntry: TaskQueueEntry | null,
    profileSummary: NextStepProfileSummary | null
): boolean {
    const profile = String(
        profileSummary?.effective_profile
        || profileSummary?.task_selected_profile
        || taskEntry?.profile
        || ''
    ).trim().toLowerCase();
    return profile === 'strict';
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function getPreflightMetricNumber(
    preflight: Record<string, unknown> | null,
    field: string
): number | null {
    const metrics = isPlainRecord(preflight?.metrics) ? preflight.metrics : {};
    return parseOptionalNumberField(metrics[field]);
}

function getCompanionScopeEffectivePreflightMetricNumber(
    preflight: Record<string, unknown> | null,
    field: 'changed_files_count' | 'changed_lines_total'
): number | null {
    const triggers = getPreflightTriggers(preflight);
    if (triggers.ui_i18n_companion_scope !== true) {
        return null;
    }
    const effectiveField = field === 'changed_files_count'
        ? 'companion_scope_effective_changed_files_count'
        : 'companion_scope_effective_changed_lines_total';
    return getPreflightMetricNumber(preflight, effectiveField);
}

function getPreflightChangedFilesCount(preflight: Record<string, unknown> | null): number {
    return getCompanionScopeEffectivePreflightMetricNumber(preflight, 'changed_files_count')
        ?? getPreflightMetricNumber(preflight, 'changed_files_count')
        ?? getPreflightChangedFiles(preflight).length;
}

function collectStrictDecompositionTaskRiskSignals(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const text = taskEntry
        ? normalizeStrictDecompositionSearchText(taskEntry.area, taskEntry.title, taskEntry.notes)
        : normalizeStrictDecompositionSearchText(getStringField(taskMode, 'task_summary', ''));
    return STRICT_DECOMPOSITION_STRONG_RISK_TERMS
        .filter((term) => containsStrictDecompositionTerm(text, term))
        .map((term) => `task_text:${term}`);
}

function collectStrictDecompositionBroadTaskRiskSignals(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const text = taskEntry
        ? normalizeStrictDecompositionSearchText(taskEntry.area, taskEntry.title, taskEntry.notes)
        : normalizeStrictDecompositionSearchText(getStringField(taskMode, 'task_summary', ''));
    const matchedDomains = STRICT_DECOMPOSITION_BROAD_DOMAIN_TERMS
        .filter((domain) => domain.aliases.some((alias) => containsStrictDecompositionBroadAlias(text, alias)))
        .map((domain) => domain.key);
    if (matchedDomains.length < STRICT_DECOMPOSITION_BROAD_DOMAIN_THRESHOLD) {
        return [];
    }

    const signals = [`task_text:broad-domains=${matchedDomains.join('+')}`];
    const separatorCount = (text.match(/[;,]/g) || []).length;
    if (separatorCount >= 4) {
        signals.push('task_text:broad-enumerated-scope');
    }
    return signals;
}

function collectStrictDecompositionPreflightRiskSignals(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): string[] {
    if (!preflight) {
        return [];
    }

    const signals: string[] = [];
    const changedFilesCount = getPreflightChangedFilesCount(preflight);
    const changedLinesTotal = getCompanionScopeEffectivePreflightMetricNumber(preflight, 'changed_lines_total')
        ?? getPreflightMetricNumber(preflight, 'changed_lines_total')
        ?? 0;
    if (changedFilesCount >= STRICT_DECOMPOSITION_CHANGED_FILE_THRESHOLD) {
        signals.push(`changed_files_count=${changedFilesCount}`);
    }
    if (changedLinesTotal >= STRICT_DECOMPOSITION_CHANGED_LINE_THRESHOLD) {
        signals.push(`changed_lines_total=${changedLinesTotal}`);
    }
    if (requiredReviewTypes.length >= STRICT_DECOMPOSITION_REVIEW_COUNT_THRESHOLD) {
        signals.push(`required_reviews=${requiredReviewTypes.join(',')}`);
    }

    const scopeCategory = String(preflight.scope_category || '').trim().toLowerCase();
    if (scopeCategory === 'mixed') {
        signals.push('scope_category=mixed');
    }

    const triggers = getPreflightTriggers(preflight);
    for (const triggerName of ['api', 'security', 'infra', 'dependency', 'db', 'performance']) {
        if (triggers[triggerName] === true) {
            signals.push(`trigger:${triggerName}`);
        }
    }
    if (
        triggers.protected_control_plane_changed === true
        || (Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0)
    ) {
        signals.push('trigger:protected-control-plane');
    }
    return signals;
}

function hasTinyStrictDecompositionExemption(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[],
    taskRiskSignals: string[]
): boolean {
    if (taskRiskSignals.length > 0) {
        return false;
    }
    const text = taskEntry
        ? normalizeStrictDecompositionSearchText(taskEntry.area, taskEntry.title, taskEntry.notes)
        : normalizeStrictDecompositionSearchText(getStringField(taskMode, 'task_summary', ''));
    const hasLowRiskTerm = STRICT_DECOMPOSITION_LOW_RISK_TERMS.some((term) => containsStrictDecompositionDelimitedTerm(text, term));
    if (!hasLowRiskTerm) {
        return false;
    }
    if (!preflight) {
        return true;
    }
    return getPreflightChangedFilesCount(preflight) <= 1
        && (
            getCompanionScopeEffectivePreflightMetricNumber(preflight, 'changed_lines_total')
            ?? getPreflightMetricNumber(preflight, 'changed_lines_total')
            ?? 0
        ) <= 20
        && requiredReviewTypes.length <= 1;
}

export function buildStrictDecompositionDecisionRequirement(params: {
    taskId: string;
    taskEntry: TaskQueueEntry | null;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    profileSummary: NextStepProfileSummary | null;
    requiredReviewTypes: string[];
}): StrictDecompositionDecisionRequirement {
    const taskSummary = getStrictDecompositionDecisionTaskSummary(params.taskId, params.taskEntry, params.taskMode);
    if (!isStrictProfileSelected(params.taskEntry, params.profileSummary)) {
        return {
            required: false,
            taskSummary,
            riskSignals: []
        };
    }

    const strongTaskRiskSignals = collectStrictDecompositionTaskRiskSignals(params.taskEntry, params.taskMode);
    const broadTaskRiskSignals = collectStrictDecompositionBroadTaskRiskSignals(params.taskEntry, params.taskMode);
    const preflightRiskSignals = collectStrictDecompositionPreflightRiskSignals(params.preflight, params.requiredReviewTypes);
    if (
        hasTinyStrictDecompositionExemption(
            params.taskEntry,
            params.taskMode,
            params.preflight,
            params.requiredReviewTypes,
            [...strongTaskRiskSignals, ...broadTaskRiskSignals]
        )
    ) {
        return {
            required: false,
            taskSummary,
            riskSignals: []
        };
    }

    const riskSignals = [...new Set([...strongTaskRiskSignals, ...broadTaskRiskSignals, ...preflightRiskSignals])].sort();
    return {
        required: riskSignals.length > 0,
        taskSummary,
        riskSignals
    };
}

function buildStrictDecompositionDecisionCommand(params: {
    cliPrefix: string;
    taskId: string;
    taskSummary: string;
    riskSignals: string[];
    requiredReviewTypes: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate record-strict-decomposition-decision`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--decision ${quoteCommandValue('<atomic|single-cycle|split-required>')}`,
        `--task-summary ${quoteCommandValue(params.taskSummary)}`,
        `--reason ${quoteCommandValue('<why this strict task is atomic, single-cycle, or must split>')}`,
        `--scope-risk ${quoteCommandValue(`Strict decomposition prompt required by next-step risk signals: ${params.riskSignals.join(', ')}.`)}`
    ];
    const expectedReviewTypes = params.requiredReviewTypes.length > 0 ? params.requiredReviewTypes : ['none'];
    for (const reviewType of expectedReviewTypes) {
        parts.push(`--expected-review-type ${quoteCommandValue(reviewType)}`);
    }
    parts.push(`--atomicity-constraint ${quoteCommandValue('<constraint or none>')}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function buildStrictDecompositionEvidenceArtifactState(
    repoRoot: string,
    evidence: StrictDecompositionDecisionEvidenceResult
): NextStepArtifactState {
    return {
        key: 'strict-decomposition-decision',
        path: evidence.evidence_path ? toRepoDisplayPath(repoRoot, evidence.evidence_path) : '<unknown>',
        exists: evidence.evidence_status !== 'EVIDENCE_FILE_MISSING'
    };
}

export function resolveStrictDecompositionContinuationRoute(params: {
    repoRoot: string;
    eventsRoot: string;
    taskEntries: Map<string, TaskQueueEntry>;
    taskId: string;
    cliPrefix: string;
    requirement: StrictDecompositionDecisionRequirement;
    requiredReviewTypes: string[];
    baseMissingArtifacts: NextStepArtifactState[];
    basePresentArtifacts: NextStepArtifactState[];
}): NextStepStrictDecompositionRoute | null {
    if (!params.requirement.required) {
        return null;
    }

    const evidence = getStrictDecompositionDecisionEvidence(
        params.repoRoot,
        params.taskId,
        '',
        params.requirement.taskSummary
    );
    const artifactState = buildStrictDecompositionEvidenceArtifactState(params.repoRoot, evidence);
    if (evidence.evidence_status !== 'PASS') {
        return {
            status: 'BLOCKED',
            nextGate: 'record-strict-decomposition-decision',
            title: 'Record strict decomposition decision before implementation.',
            reason:
                'This strict task is risky or umbrella-shaped, so next-step requires a current strict decomposition decision before ordinary classify, compile, review, full-suite, completion, or implementation continuation. ' +
                `Evidence status: ${formatNextStepInlineValue(evidence.evidence_status)}. ` +
                `Risk signals: ${formatNextStepInlineList(params.requirement.riskSignals)}. ` +
                'Choose atomic, single-cycle, or split-required explicitly; atomic and single-cycle are not review waivers, and later scope-budget or review-cycle split latches still override the decision.',
            commands: [
                buildCommand(
                    'Record strict decomposition decision',
                    buildStrictDecompositionDecisionCommand({
                        cliPrefix: params.cliPrefix,
                        taskId: params.taskId,
                        taskSummary: params.requirement.taskSummary,
                        riskSignals: params.requirement.riskSignals,
                        requiredReviewTypes: params.requiredReviewTypes
                    })
                )
            ],
            missingArtifacts: artifactState.exists
                ? params.baseMissingArtifacts
                : [...params.baseMissingArtifacts, artifactState],
            presentArtifacts: artifactState.exists
                ? [...params.basePresentArtifacts, artifactState]
                : params.basePresentArtifacts
        };
    }

    if (evidence.decision !== 'split-required') {
        return null;
    }

    const splitRoutingState = resolveStrictDecompositionSplitRoutingState(
        params.taskEntries,
        params.taskId,
        evidence.proposed_child_task_ids
    );
    if (!splitRoutingState.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'strict-decomposition-split-routing',
            title: 'Strict decomposition split decision is active.',
            reason:
                'A current strict decomposition decision says split-required, so ordinary classify, compile, review, full-suite, completion, and implementation continuation are suppressed. ' +
                `Risk signals: ${formatNextStepInlineList(params.requirement.riskSignals)}. ` +
                `Proposed child tasks: ${formatNextStepInlineList(evidence.proposed_child_task_ids)}. ` +
                `Linked child tasks: ${formatNextStepInlineList(splitRoutingState.linkedChildTaskIds)}. ` +
                `Child routing is not ready: ${formatStrictDecompositionSplitRoutingViolations(splitRoutingState)}. ` +
                'Create and link parent-derived strict child task rows that match the decision artifact before continuing; later scope-budget or review-cycle split latches remain authoritative.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: [...params.basePresentArtifacts, artifactState],
            finalReport: null
        };
    }

    const syncResult = transitionStrictDecompositionParentToDecomposed({
        repoRoot: params.repoRoot,
        eventsRoot: params.eventsRoot,
        taskId: params.taskId
    });
    const strictSplitRoute = resolveStrictDecompositionSplitTerminalRoute({
        taskId: params.taskId,
        transitionResult: {
            outcome: syncResult.outcome,
            errorMessage: syncResult.error_message
        },
        childRoute: splitRoutingState.childRoute,
        continueChildCommand: splitRoutingState.childRoute
            ? buildCommand(
                'Continue child task',
                `${params.cliPrefix} next-step "${splitRoutingState.childRoute.taskId}" --repo-root "."`
            )
            : null
    });
    return {
        status: strictSplitRoute.status,
        nextGate: strictSplitRoute.nextGate,
        title: strictSplitRoute.title,
        reason: strictSplitRoute.reason,
        commands: strictSplitRoute.commands,
        missingArtifacts: [],
        presentArtifacts: [...params.basePresentArtifacts, artifactState],
        finalReport: null
    };
}
