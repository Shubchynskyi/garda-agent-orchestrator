import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { resolveBundleNameForTarget } from '../core/constants';
import { buildWorkflowConfigTab } from './report-data-contract';
import {
    WORKFLOW_SETTING_DEFINITIONS,
    type WorkflowSettingOption,
    type WorkflowSettingValueType
} from './workflow-setting-metadata';

export type UiActionMode = 'preview' | 'execute';

export interface UiActionCommand {
    executable: string;
    args: string[];
    display: string;
}

export interface UiActionDefinition {
    id: string;
    category: string;
    label: string;
    description: string;
    mutates: boolean;
    requires_confirmation: boolean;
    confirmation_phrase: string | null;
    command: UiActionCommand;
}

export type UiSwitchModeState = 'on' | 'off' | 'unknown';

export interface UiSettingDefinition {
    id: string;
    key: string;
    label: string;
    description: string;
    flag: string;
    current_value: unknown;
    value_type: WorkflowSettingValueType;
    options: WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
    confirmation_phrase: string;
}

export interface UiActionRunnerResult {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}

export type UiActionRunner = (action: UiActionDefinition, repoRoot: string) => Promise<UiActionRunnerResult>;

export interface UiActionAuditRecord {
    timestamp_utc: string;
    action_id: string;
    mode: UiActionMode;
    status: string;
    command: string;
    exit_code?: number | null;
    signal?: string | null;
    error?: string;
}

function quoteCommandPart(value: string): string {
    return /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

function resolveGardaCliPath(repoRoot: string): string {
    const sourceCliPath = path.join(repoRoot, 'bin', 'garda.js');
    if (fs.existsSync(sourceCliPath)) {
        return sourceCliPath;
    }
    return path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js');
}

function resolveBundleRoot(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
}

export function detectUiSwitchModeState(repoRoot: string): UiSwitchModeState {
    const bundleRoot = resolveBundleRoot(repoRoot);
    const statePath = path.join(bundleRoot, 'runtime', 'switch', 'state.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        if (parsed.mode === 'on' || parsed.mode === 'off') {
            return parsed.mode;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return 'unknown';
        }
    }

    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    try {
        const content = fs.readFileSync(agentsPath, 'utf8');
        if (content.includes('garda-agent-orchestrator:managed-start')) {
            return 'on';
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return 'unknown';
        }
    }

    const offAgentsPath = path.join(bundleRoot, 'runtime', 'switch', 'off', 'AGENTS.md');
    return fs.existsSync(offAgentsPath) ? 'off' : 'unknown';
}

function displayGardaCommand(repoRoot: string, cliPath: string, args: string[]): string {
    const relativeCliPath = path.relative(repoRoot, cliPath).replace(/\\/gu, '/') || cliPath;
    const displayArgs = args.map((argument) => argument === repoRoot ? '.' : argument);
    return ['node', relativeCliPath, ...displayArgs].map(quoteCommandPart).join(' ');
}

export function buildUiActionDefinitions(repoRoot: string): UiActionDefinition[] {
    const cliPath = resolveGardaCliPath(repoRoot);
    const buildAction = (
        id: string,
        category: string,
        label: string,
        description: string,
        args: string[],
        options: { mutates?: boolean; confirmationPhrase?: string } = {}
    ): UiActionDefinition => ({
        id,
        category,
        label,
        description,
        mutates: options.mutates === true,
        requires_confirmation: Boolean(options.confirmationPhrase),
        confirmation_phrase: options.confirmationPhrase || null,
        command: {
            executable: process.execPath,
            args: [cliPath, ...args],
            display: displayGardaCommand(repoRoot, cliPath, args)
        }
    });
    return [
        buildAction(
            'garda-off',
            'Garda switch',
            'Turn Garda Off',
            'Move managed Garda root instruction files into inactive switch storage.',
            ['off', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA OFF' }
        ),
        buildAction(
            'garda-on',
            'Garda switch',
            'Turn Garda On',
            'Restore managed Garda root instruction files from switch storage.',
            ['on', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA ON' }
        ),
        buildAction(
            'status',
            'Inspection',
            'Status',
            'Run the existing Garda status command for this workspace.',
            ['status', '--target-root', repoRoot]
        ),
        buildAction(
            'doctor',
            'Inspection',
            'Doctor',
            'Run Garda workspace diagnostics, including init answers, manifests, generated files, locks, and bundle health. This is read-only unless explicit cleanup flags are added elsewhere.',
            ['doctor', '--target-root', repoRoot]
        ),
        buildAction(
            'html-report',
            'Export',
            'Generate HTML Report',
            'Run the existing Garda html command with lazy task details.',
            ['html', '--target-root', repoRoot, '--max-detailed-tasks', '0'],
            { mutates: true, confirmationPhrase: 'RUN GARDA HTML' }
        ),
        buildAction(
            'cleanup-preview',
            'Maintenance',
            'Preview Runtime Cleanup',
            'Dry-run runtime cleanup. Shows candidate task events, reviews, reports, backups, rollbacks, metrics, and working plans that match retention limits. Nothing is deleted.',
            ['cleanup', '--target-root', repoRoot, '--dry-run']
        ),
        buildAction(
            'cleanup-apply',
            'Maintenance',
            'Apply Runtime Cleanup',
            'Applies the same retention cleanup shown by preview. Risk: old runtime evidence can be removed or compressed, so review the preview first and do not run while another task is active.',
            ['cleanup', '--target-root', repoRoot, '--confirm'],
            { mutates: true, confirmationPhrase: 'RUN GARDA CLEANUP' }
        )
    ];
}

export function buildUiTaskActionDefinitions(repoRoot: string, taskId: string): UiActionDefinition[] {
    const cliPath = resolveGardaCliPath(repoRoot);
    const buildTaskAction = (
        id: string,
        label: string,
        description: string,
        args: string[],
        options: { mutates?: boolean; confirmationPhrase?: string } = {}
    ): UiActionDefinition => ({
        id,
        category: 'Task',
        label,
        description,
        mutates: options.mutates === true,
        requires_confirmation: Boolean(options.confirmationPhrase),
        confirmation_phrase: options.confirmationPhrase || null,
        command: {
            executable: process.execPath,
            args: [cliPath, ...args],
            display: displayGardaCommand(repoRoot, cliPath, args)
        }
    });
    return [
        buildTaskAction(
            'task-next-step',
            'Next lifecycle step',
            'Run the task router and print the next required lifecycle command.',
            ['next-step', taskId, '--repo-root', repoRoot],
            { mutates: true, confirmationPhrase: 'RUN TASK NEXT STEP' }
        ),
        buildTaskAction(
            'task-stats',
            'Task stats',
            'Run the focused task stats command.',
            ['task', taskId, 'stats', '--target-root', repoRoot]
        ),
        buildTaskAction(
            'task-events',
            'Task events',
            'Run the focused task events command.',
            ['task', taskId, 'events', '--target-root', repoRoot]
        )
    ];
}

const UI_SETTING_CONFIRMATION_PHRASE = 'APPLY GARDA SETTING';

export function buildUiSettingDefinitions(repoRoot: string): UiSettingDefinition[] {
    const settings = buildWorkflowConfigTab(repoRoot).settings;
    return WORKFLOW_SETTING_DEFINITIONS
        .filter((definition) => definition.editable !== false)
        .map((definition) => {
            const reportSetting = settings.find((setting) => setting.key === definition.key);
            return {
                ...definition,
                options: reportSetting?.options ?? definition.options,
                current_value: reportSetting?.value,
                confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE
            };
        });
}

export function findSetting(settings: UiSettingDefinition[], settingId: unknown): UiSettingDefinition | null {
    if (typeof settingId !== 'string') {
        return null;
    }
    return settings.find((setting) => setting.id === settingId) || null;
}

export interface ParsedUiSettingValue {
    command_value: string;
    proposed_value: unknown;
}

function normalizeEnumListValue(value: unknown): string[] {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'number'
            ? [String(value)]
            : typeof value === 'string'
                ? value.split(',')
                : [];
    return [...new Set(rawValues
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean))];
}

export function parseUiSettingValue(setting: UiSettingDefinition, value: unknown): ParsedUiSettingValue {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (setting.value_type === 'integer') {
        if (!/^\d+$/u.test(raw)) {
            throw new Error(`${setting.label} must be an integer.`);
        }
        const parsed = Number(raw);
        const min = setting.min ?? 1;
        const max = setting.max ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`${setting.label} must be an integer from ${min} to ${max}.`);
        }
        return {
            command_value: String(parsed),
            proposed_value: parsed
        };
    }
    if (setting.value_type === 'boolean') {
        const normalized = raw.toLowerCase();
        if (!['true', 'false', 'on', 'off', 'yes', 'no', '1', '0'].includes(normalized)) {
            throw new Error(`${setting.label} must be on or off.`);
        }
        const enabled = ['true', 'on', 'yes', '1'].includes(normalized);
        return {
            command_value: String(enabled),
            proposed_value: enabled
        };
    }
    if (setting.value_type === 'enum') {
        const option = setting.options.find((candidate) => candidate.value === raw);
        if (!option) {
            throw new Error(`${setting.label} must be one of: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: option.value,
            proposed_value: option.value
        };
    }
    if (setting.value_type === 'enum_list') {
        const values = normalizeEnumListValue(value);
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        const allowedValues = new Set(setting.options.map((candidate) => candidate.value));
        const invalidValues = values.filter((entry) => !allowedValues.has(entry));
        if (invalidValues.length > 0) {
            throw new Error(`${setting.label} contains unsupported value(s): ${invalidValues.join(', ')}. Allowed values: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (setting.value_type === 'string_list') {
        const values = [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (!raw) {
        throw new Error(`${setting.label} must not be empty.`);
    }
    return {
        command_value: raw,
        proposed_value: raw
    };
}

function buildUiSettingCommand(repoRoot: string, setting: UiSettingDefinition, commandValue: string, timestampUtc: string): UiActionCommand {
    const cliPath = resolveGardaCliPath(repoRoot);
    const args = [
        'workflow',
        'set',
        setting.flag,
        commandValue,
        '--target-root',
        repoRoot,
        '--operator-confirmed',
        'yes',
        '--operator-confirmed-at-utc',
        timestampUtc
    ];
    return {
        executable: process.execPath,
        args: [cliPath, ...args],
        display: displayGardaCommand(repoRoot, cliPath, args)
    };
}

export function buildUiSettingAction(repoRoot: string, setting: UiSettingDefinition, commandValue: string, timestampUtc: string): UiActionDefinition {
    return {
        id: `setting:${setting.id}`,
        category: 'Workflow Config',
        label: setting.label,
        description: setting.description,
        mutates: true,
        requires_confirmation: true,
        confirmation_phrase: setting.confirmation_phrase,
        command: buildUiSettingCommand(repoRoot, setting, commandValue, timestampUtc)
    };
}

function capOutput(value: string, maxChars = 512000): string {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}\n[output truncated at ${maxChars} chars]`;
}

function buildUiActionEnv(): NodeJS.ProcessEnv {
    const allowedKeys = [
        'PATH',
        'Path',
        'PATHEXT',
        'SystemRoot',
        'WINDIR',
        'COMSPEC',
        'ComSpec',
        'TEMP',
        'TMP',
        'HOME',
        'USERPROFILE',
        'LOCALAPPDATA',
        'APPDATA',
        'NO_COLOR',
        'FORCE_COLOR',
        'CI'
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowedKeys) {
        const value = process.env[key];
        if (value !== undefined) {
            env[key] = value;
        }
    }
    return env;
}

export function runUiActionCommand(action: UiActionDefinition, repoRoot: string): Promise<UiActionRunnerResult> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(action.command.executable, action.command.args, {
            cwd: repoRoot,
            env: buildUiActionEnv(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill();
        }, 60000);
        child.stdout?.on('data', (chunk) => {
            stdout = capOutput(stdout + String(chunk));
        });
        child.stderr?.on('data', (chunk) => {
            stderr = capOutput(stderr + String(chunk));
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(timeout);
            resolve({
                exit_code: exitCode,
                signal,
                stdout,
                stderr
            });
        });
    });
}

function getUiActionAuditPath(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'ui-actions', 'audit.jsonl');
}

export function appendUiActionAudit(repoRoot: string, record: UiActionAuditRecord): string {
    const auditPath = getUiActionAuditPath(repoRoot);
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
    return auditPath;
}

export function findAction(actions: UiActionDefinition[], actionId: unknown): UiActionDefinition | null {
    if (typeof actionId !== 'string') {
        return null;
    }
    return actions.find((action) => action.id === actionId) || null;
}

export function formatPublicAction(action: UiActionDefinition): Record<string, unknown> {
    return {
        id: action.id,
        category: action.category,
        label: action.label,
        description: action.description,
        mutates: action.mutates,
        requires_confirmation: action.requires_confirmation,
        confirmation_phrase: action.confirmation_phrase,
        command: action.command.display
    };
}
