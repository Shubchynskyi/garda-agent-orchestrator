import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    resolveBundleName
} from '../../core/constants';
import {
    REVIEW_EXECUTION_POLICY_MODES,
    buildReviewExecutionPolicySummaryLine,
    describeReviewExecutionPolicy,
    normalizeReviewExecutionPolicyMode,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    type EffectiveReviewExecutionPolicyMode,
    type ReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildDefaultWorkflowConfig,
    hasMaterializedWorkflowConfigBaseline,
    type WorkflowConfigData
} from '../../core/workflow-config';
import {
    OUT_OF_SCOPE_FAILURE_POLICIES,
    type OutOfScopeFailurePolicy
} from '../../gates/full-suite-validation';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    buildGuardedCommandHelpText,
    normalizePathValue,
    parseOptions,
    PackageJsonLike
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

type WorkflowFileConfigData = {
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy?: WorkflowConfigData['review_execution_policy'];
    [key: string]: unknown;
};

type WorkflowReviewExecutionPolicyView = {
    mode: EffectiveReviewExecutionPolicyMode;
    configured: boolean;
    allowed_modes: readonly ReviewExecutionPolicyMode[];
    description: string;
    visible_summary_line: string;
};

interface WorkflowCommandRoots {
    targetRoot: string;
    bundleRoot: string;
    configPath: string;
}

interface WorkflowConfigState {
    rawConfig: WorkflowFileConfigData | null;
    config: WorkflowFileConfigData;
    exists: boolean;
    missingReviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode | null;
}

interface WorkflowCommandResultBase {
    scope: 'repo-local';
    target_root: string;
    bundle_root: string;
    config_path: string;
    config_exists: boolean;
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy: WorkflowReviewExecutionPolicyView;
    visible_summary_line: string;
    review_execution_policy_summary_line: string;
}

interface WorkflowShowResult extends WorkflowCommandResultBase {
    action: 'show';
}

interface WorkflowSetResult extends WorkflowCommandResultBase {
    action: 'set';
    status: 'CHANGED' | 'NO_CHANGE';
    changed: boolean;
    changed_fields: string[];
}

const WORKFLOW_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

const WORKFLOW_SET_DEFINITIONS = {
    ...WORKFLOW_SHARED_DEFINITIONS,
    '--full-suite-enabled': { key: 'fullSuiteEnabled', type: 'string' },
    '--full-suite-command': { key: 'fullSuiteCommand', type: 'string' },
    '--full-suite-timeout-ms': { key: 'fullSuiteTimeoutMs', type: 'string' },
    '--full-suite-green-summary-max-lines': { key: 'fullSuiteGreenSummaryMaxLines', type: 'string' },
    '--full-suite-red-failure-chunk-lines': { key: 'fullSuiteRedFailureChunkLines', type: 'string' },
    '--full-suite-out-of-scope-failure-policy': { key: 'fullSuiteOutOfScopeFailurePolicy', type: 'string' },
    '--review-execution-policy': { key: 'reviewExecutionPolicy', type: 'string' }
};

function resolveWorkflowRoots(options: ParsedOptionsRecord): WorkflowCommandRoots {
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : explicitBundleRoot
            ? path.dirname(explicitBundleRoot)
            : normalizePathValue('.');
    const bundleRoot = explicitBundleRoot ?? path.join(targetRoot, resolveBundleName());
    return {
        targetRoot,
        bundleRoot,
        configPath: path.join(bundleRoot, 'live', 'config', 'workflow-config.json')
    };
}

function readWorkflowConfigState(configPath: string, bundleRoot: string): WorkflowConfigState {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
        return {
            rawConfig: null,
            config: {
                full_suite_validation: defaultConfig.full_suite_validation
            },
            exists: false,
            missingReviewExecutionPolicyMode: hasMaterializedWorkflowConfigBaseline(bundleRoot)
                ? 'legacy_test_downstream'
                : defaultConfig.review_execution_policy.mode
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    try {
        const validated = validateWorkflowConfig(parsed) as WorkflowFileConfigData;
        return {
            rawConfig: validated,
            config: validated,
            exists: true,
            missingReviewExecutionPolicyMode: null
        };
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildMandatoryFullSuiteLine(config: { full_suite_validation: WorkflowConfigData['full_suite_validation'] }): string {
    return `Mandatory full-suite: ${config.full_suite_validation.enabled ? 'true' : 'false'}`;
}

function buildReviewExecutionPolicyView(state: WorkflowConfigState): WorkflowReviewExecutionPolicyView {
    if (state.missingReviewExecutionPolicyMode) {
        const mode = state.missingReviewExecutionPolicyMode;
        return {
            mode,
            configured: false,
            allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
            description: describeReviewExecutionPolicy(mode),
            visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
        };
    }
    const resolved = resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        state.config,
        'legacy_test_downstream'
    );
    const mode = resolved.mode;
    return {
        mode,
        configured: resolved.configured,
        allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
        description: describeReviewExecutionPolicy(mode),
        visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
    };
}

function buildWorkflowShowResult(
    roots: WorkflowCommandRoots,
    state: WorkflowConfigState
): WorkflowShowResult {
    const reviewExecutionPolicy = buildReviewExecutionPolicyView(state);
    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        full_suite_validation: state.config.full_suite_validation,
        review_execution_policy: reviewExecutionPolicy,
        visible_summary_line: buildMandatoryFullSuiteLine(state.config),
        review_execution_policy_summary_line: reviewExecutionPolicy.visible_summary_line
    };
}

function formatWorkflowShowOutput(result: WorkflowCommandResultBase & { action: 'show' | 'set' }, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const fullSuiteValidation = result.full_suite_validation;
    const reviewExecutionPolicy = result.review_execution_policy;
    const lines: string[] = [];
    lines.push('GARDA_WORKFLOW');
    lines.push(`Action: ${result.action}`);
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push(result.visible_summary_line);
    lines.push(result.review_execution_policy_summary_line);
    lines.push(`FullSuiteEnabled: ${fullSuiteValidation.enabled}`);
    lines.push(`FullSuiteCommand: ${fullSuiteValidation.command}`);
    lines.push(`FullSuiteTimeoutMs: ${fullSuiteValidation.timeout_ms}`);
    lines.push(`FullSuiteGreenSummaryMaxLines: ${fullSuiteValidation.green_summary_max_lines}`);
    lines.push(`FullSuiteRedFailureChunkLines: ${fullSuiteValidation.red_failure_chunk_lines}`);
    lines.push(`FullSuiteOutOfScopeFailurePolicy: ${fullSuiteValidation.out_of_scope_failure_policy}`);
    lines.push(`ReviewExecutionPolicy: ${reviewExecutionPolicy.mode}`);
    lines.push(`ReviewExecutionPolicyConfigured: ${reviewExecutionPolicy.configured}`);
    lines.push(`ReviewExecutionPolicyDescription: ${reviewExecutionPolicy.description}`);
    lines.push(`ReviewExecutionPolicyAllowedModes: ${reviewExecutionPolicy.allowed_modes.join(', ')}`);
    lines.push('Tip: run "workflow set --full-suite-enabled true|false" to change the repo-local mode.');
    lines.push(`Tip: run "workflow set --review-execution-policy <${REVIEW_EXECUTION_POLICY_MODES.join('|')}>" to change review launch ordering.`);
    return lines.join('\n');
}

function parseBooleanText(value: string, flagName: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', '0', 'off'].includes(normalized)) {
        return false;
    }
    throw new Error(`${flagName} must be true or false.`);
}

function parseIntegerText(value: string, flagName: string, minimum: number): number {
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${flagName} must be an integer.`);
    }
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed < minimum) {
        throw new Error(`${flagName} must be >= ${minimum}.`);
    }
    return parsed;
}

function parseOutOfScopeFailurePolicy(value: string): OutOfScopeFailurePolicy {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        throw new Error(
            '--full-suite-out-of-scope-failure-policy must be one of: '
            + OUT_OF_SCOPE_FAILURE_POLICIES.join(', ')
            + '.'
        );
    }
    return normalized as OutOfScopeFailurePolicy;
}

function writeWorkflowConfig(configPath: string, config: WorkflowFileConfigData): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateWorkflowConfig(config) as WorkflowFileConfigData;
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

function handleShow(options: ParsedOptionsRecord): WorkflowShowResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result = buildWorkflowShowResult(roots, state);
    console.log(formatWorkflowShowOutput(result, options.json === true));
    return result;
}

function handleSet(options: ParsedOptionsRecord): WorkflowSetResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const preserveLegacyMissingReviewExecutionPolicy = !state.exists
        && hasMaterializedWorkflowConfigBaseline(roots.bundleRoot)
        && typeof options.reviewExecutionPolicy !== 'string';
    const mutableBaseConfig = state.rawConfig
        ?? (preserveLegacyMissingReviewExecutionPolicy
            ? { full_suite_validation: state.config.full_suite_validation }
            : buildDefaultWorkflowConfig());
    const nextConfig = JSON.parse(JSON.stringify(
        mutableBaseConfig
    )) as WorkflowFileConfigData;
    const nextFullSuiteValidation = JSON.parse(
        JSON.stringify(state.config.full_suite_validation)
    ) as WorkflowConfigData['full_suite_validation'];
    const changedFields: string[] = [];

    if (typeof options.fullSuiteEnabled === 'string') {
        nextFullSuiteValidation.enabled = parseBooleanText(options.fullSuiteEnabled, '--full-suite-enabled');
        changedFields.push('full_suite_validation.enabled');
    }
    if (typeof options.fullSuiteCommand === 'string') {
        const command = options.fullSuiteCommand.trim();
        if (!command) {
            throw new Error('--full-suite-command must not be empty.');
        }
        nextFullSuiteValidation.command = command;
        changedFields.push('full_suite_validation.command');
    }
    if (typeof options.fullSuiteTimeoutMs === 'string') {
        nextFullSuiteValidation.timeout_ms = parseIntegerText(
            options.fullSuiteTimeoutMs,
            '--full-suite-timeout-ms',
            1000
        );
        changedFields.push('full_suite_validation.timeout_ms');
    }
    if (typeof options.fullSuiteGreenSummaryMaxLines === 'string') {
        nextFullSuiteValidation.green_summary_max_lines = parseIntegerText(
            options.fullSuiteGreenSummaryMaxLines,
            '--full-suite-green-summary-max-lines',
            1
        );
        changedFields.push('full_suite_validation.green_summary_max_lines');
    }
    if (typeof options.fullSuiteRedFailureChunkLines === 'string') {
        nextFullSuiteValidation.red_failure_chunk_lines = parseIntegerText(
            options.fullSuiteRedFailureChunkLines,
            '--full-suite-red-failure-chunk-lines',
            10
        );
        changedFields.push('full_suite_validation.red_failure_chunk_lines');
    }
    if (typeof options.fullSuiteOutOfScopeFailurePolicy === 'string') {
        nextFullSuiteValidation.out_of_scope_failure_policy = parseOutOfScopeFailurePolicy(
            options.fullSuiteOutOfScopeFailurePolicy
        );
        changedFields.push('full_suite_validation.out_of_scope_failure_policy');
    }
    nextConfig.full_suite_validation = nextFullSuiteValidation;
    if (typeof options.reviewExecutionPolicy === 'string') {
        nextConfig.review_execution_policy = {
            mode: normalizeReviewExecutionPolicyMode(
            options.reviewExecutionPolicy,
            '--review-execution-policy'
            )
        };
        changedFields.push('review_execution_policy.mode');
    }

    if (changedFields.length === 0) {
        throw new Error(
            "Workflow setting flags are required for 'workflow set'. "
            + 'Use --full-suite-enabled, --full-suite-command, --full-suite-timeout-ms, '
            + '--full-suite-green-summary-max-lines, --full-suite-red-failure-chunk-lines, '
            + '--full-suite-out-of-scope-failure-policy, or --review-execution-policy.'
        );
    }

    const currentSerialized = JSON.stringify(
        validateWorkflowConfig(state.rawConfig ?? { full_suite_validation: state.config.full_suite_validation }),
        null,
        2
    ) + '\n';
    const nextValidated = validateWorkflowConfig(nextConfig) as WorkflowFileConfigData;
    const nextSerialized = JSON.stringify(nextValidated, null, 2) + '\n';
    const changed = !state.exists || nextSerialized !== currentSerialized;

    if (changed) {
        writeWorkflowConfig(roots.configPath, nextValidated);
    }

    const result: WorkflowSetResult = {
        ...buildWorkflowShowResult(roots, {
            rawConfig: nextValidated,
            config: nextValidated,
            exists: state.exists || changed,
            missingReviewExecutionPolicyMode: null
        }),
        action: 'set',
        status: changed ? 'CHANGED' : 'NO_CHANGE',
        changed,
        changed_fields: changedFields
    };
    console.log(formatWorkflowShowOutput(result, options.json === true));
    if (options.json !== true) {
        console.log(`Status: ${result.status}`);
        console.log(`ChangedFields: ${result.changed_fields.join(', ')}`);
    }
    return result;
}

export function handleWorkflow(
    commandArgv: string[],
    packageJson: PackageJsonLike
): WorkflowShowResult | WorkflowSetResult | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'show';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;
    const optionDefinitions = subcommand === 'set'
        ? WORKFLOW_SET_DEFINITIONS
        : WORKFLOW_SHARED_DEFINITIONS;
    const { options } = parseOptions(subcommandArgv, optionDefinitions);

    if (options.help) { console.log(buildGuardedCommandHelpText('workflow')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    switch (subcommand) {
        case 'show':
            return handleShow(options as ParsedOptionsRecord);
        case 'set':
            return handleSet(options as ParsedOptionsRecord);
        default:
            throw new Error(`Unknown workflow action: ${subcommand}. Allowed values: show, set.`);
    }
}
