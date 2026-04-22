import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    resolveBundleName
} from '../../core/constants';
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

interface WorkflowConfigData {
    full_suite_validation: {
        enabled: boolean;
        command: string;
        timeout_ms: number;
        green_summary_max_lines: number;
        red_failure_chunk_lines: number;
        out_of_scope_failure_policy: OutOfScopeFailurePolicy;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface WorkflowCommandRoots {
    targetRoot: string;
    bundleRoot: string;
    configPath: string;
}

interface WorkflowConfigState {
    config: WorkflowConfigData;
    exists: boolean;
}

interface WorkflowCommandResultBase {
    scope: 'repo-local';
    target_root: string;
    bundle_root: string;
    config_path: string;
    config_exists: boolean;
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    visible_summary_line: string;
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
    '--full-suite-out-of-scope-failure-policy': { key: 'fullSuiteOutOfScopeFailurePolicy', type: 'string' }
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

function buildDefaultWorkflowConfig(): WorkflowConfigData {
    return {
        full_suite_validation: {
            enabled: false,
            command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        }
    };
}

function readWorkflowConfigState(configPath: string): WorkflowConfigState {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return {
            config: buildDefaultWorkflowConfig(),
            exists: false
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
        return {
            config: validateWorkflowConfig(parsed) as WorkflowConfigData,
            exists: true
        };
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildMandatoryFullSuiteLine(config: WorkflowConfigData): string {
    return `Mandatory full-suite: ${config.full_suite_validation.enabled ? 'true' : 'false'}`;
}

function buildWorkflowShowResult(
    roots: WorkflowCommandRoots,
    state: WorkflowConfigState
): WorkflowShowResult {
    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        full_suite_validation: state.config.full_suite_validation,
        visible_summary_line: buildMandatoryFullSuiteLine(state.config)
    };
}

function formatWorkflowShowOutput(result: WorkflowCommandResultBase & { action: 'show' | 'set' }, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const fullSuiteValidation = result.full_suite_validation;
    const lines: string[] = [];
    lines.push('GARDA_WORKFLOW');
    lines.push(`Action: ${result.action}`);
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push(result.visible_summary_line);
    lines.push(`FullSuiteEnabled: ${fullSuiteValidation.enabled}`);
    lines.push(`FullSuiteCommand: ${fullSuiteValidation.command}`);
    lines.push(`FullSuiteTimeoutMs: ${fullSuiteValidation.timeout_ms}`);
    lines.push(`FullSuiteGreenSummaryMaxLines: ${fullSuiteValidation.green_summary_max_lines}`);
    lines.push(`FullSuiteRedFailureChunkLines: ${fullSuiteValidation.red_failure_chunk_lines}`);
    lines.push(`FullSuiteOutOfScopeFailurePolicy: ${fullSuiteValidation.out_of_scope_failure_policy}`);
    lines.push('Tip: run "workflow set --full-suite-enabled true|false" to change the repo-local mode.');
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

function writeWorkflowConfig(configPath: string, config: WorkflowConfigData): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateWorkflowConfig(config) as WorkflowConfigData;
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

function handleShow(options: ParsedOptionsRecord): WorkflowShowResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath);
    const result = buildWorkflowShowResult(roots, state);
    console.log(formatWorkflowShowOutput(result, options.json === true));
    return result;
}

function handleSet(options: ParsedOptionsRecord): WorkflowSetResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath);
    const nextConfig = JSON.parse(JSON.stringify(state.config)) as WorkflowConfigData;
    const changedFields: string[] = [];

    if (typeof options.fullSuiteEnabled === 'string') {
        nextConfig.full_suite_validation.enabled = parseBooleanText(options.fullSuiteEnabled, '--full-suite-enabled');
        changedFields.push('full_suite_validation.enabled');
    }
    if (typeof options.fullSuiteCommand === 'string') {
        const command = options.fullSuiteCommand.trim();
        if (!command) {
            throw new Error('--full-suite-command must not be empty.');
        }
        nextConfig.full_suite_validation.command = command;
        changedFields.push('full_suite_validation.command');
    }
    if (typeof options.fullSuiteTimeoutMs === 'string') {
        nextConfig.full_suite_validation.timeout_ms = parseIntegerText(
            options.fullSuiteTimeoutMs,
            '--full-suite-timeout-ms',
            1000
        );
        changedFields.push('full_suite_validation.timeout_ms');
    }
    if (typeof options.fullSuiteGreenSummaryMaxLines === 'string') {
        nextConfig.full_suite_validation.green_summary_max_lines = parseIntegerText(
            options.fullSuiteGreenSummaryMaxLines,
            '--full-suite-green-summary-max-lines',
            1
        );
        changedFields.push('full_suite_validation.green_summary_max_lines');
    }
    if (typeof options.fullSuiteRedFailureChunkLines === 'string') {
        nextConfig.full_suite_validation.red_failure_chunk_lines = parseIntegerText(
            options.fullSuiteRedFailureChunkLines,
            '--full-suite-red-failure-chunk-lines',
            10
        );
        changedFields.push('full_suite_validation.red_failure_chunk_lines');
    }
    if (typeof options.fullSuiteOutOfScopeFailurePolicy === 'string') {
        nextConfig.full_suite_validation.out_of_scope_failure_policy = parseOutOfScopeFailurePolicy(
            options.fullSuiteOutOfScopeFailurePolicy
        );
        changedFields.push('full_suite_validation.out_of_scope_failure_policy');
    }

    if (changedFields.length === 0) {
        throw new Error(
            "Workflow setting flags are required for 'workflow set'. "
            + 'Use --full-suite-enabled, --full-suite-command, --full-suite-timeout-ms, '
            + '--full-suite-green-summary-max-lines, --full-suite-red-failure-chunk-lines, '
            + 'or --full-suite-out-of-scope-failure-policy.'
        );
    }

    const currentSerialized = JSON.stringify(validateWorkflowConfig(state.config), null, 2) + '\n';
    const nextValidated = validateWorkflowConfig(nextConfig) as WorkflowConfigData;
    const nextSerialized = JSON.stringify(nextValidated, null, 2) + '\n';
    const changed = !state.exists || nextSerialized !== currentSerialized;

    if (changed) {
        writeWorkflowConfig(roots.configPath, nextValidated);
    }

    const result: WorkflowSetResult = {
        ...buildWorkflowShowResult(roots, {
            config: nextValidated,
            exists: state.exists || changed
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
