import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { buildWorkflowConfigTab } from './report-data-contract';

export type UiActionMode = 'preview' | 'execute';

export interface UiActionCommand {
    executable: string;
    args: string[];
    display: string;
}

export interface UiActionDefinition {
    id: string;
    label: string;
    description: string;
    mutates: boolean;
    requires_confirmation: boolean;
    confirmation_phrase: string | null;
    command: UiActionCommand;
}

export interface UiSettingDefinition {
    id: string;
    key: string;
    label: string;
    description: string;
    flag: string;
    current_value: unknown;
    value_type: 'integer';
    min: number;
    max: number;
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

function displayGardaCommand(repoRoot: string, cliPath: string, args: string[]): string {
    const relativeCliPath = path.relative(repoRoot, cliPath).replace(/\\/gu, '/') || cliPath;
    const displayArgs = args.map((argument) => argument === repoRoot ? '.' : argument);
    return ['node', relativeCliPath, ...displayArgs].map(quoteCommandPart).join(' ');
}

export function buildUiActionDefinitions(repoRoot: string): UiActionDefinition[] {
    const cliPath = resolveGardaCliPath(repoRoot);
    const buildAction = (
        id: string,
        label: string,
        description: string,
        args: string[],
        options: { mutates?: boolean; confirmationPhrase?: string } = {}
    ): UiActionDefinition => ({
        id,
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
            'status',
            'Status',
            'Run the existing Garda status command for this workspace.',
            ['status', '--target-root', repoRoot]
        ),
        buildAction(
            'doctor',
            'Doctor',
            'Run the existing Garda doctor command for this workspace.',
            ['doctor', '--target-root', repoRoot]
        ),
        buildAction(
            'html-report',
            'Generate HTML Report',
            'Run the existing Garda html command with lazy task details.',
            ['html', '--target-root', repoRoot, '--max-detailed-tasks', '0'],
            { mutates: true, confirmationPhrase: 'RUN GARDA HTML' }
        )
    ];
}

const UI_SETTING_CONFIRMATION_PHRASE = 'APPLY GARDA SETTING';

const UI_SETTING_DEFINITIONS = [
    {
        id: 'full-suite-green-summary-max-lines',
        key: 'full_suite_validation.green_summary_max_lines',
        label: 'Full-suite green summary lines',
        description: 'Tune how many successful full-suite lines the gate keeps in compact human output.',
        flag: '--full-suite-green-summary-max-lines',
        min: 1,
        max: 200
    },
    {
        id: 'full-suite-red-failure-chunk-lines',
        key: 'full_suite_validation.red_failure_chunk_lines',
        label: 'Full-suite failure chunk lines',
        description: 'Tune how many failing full-suite lines the gate keeps per compact failure chunk.',
        flag: '--full-suite-red-failure-chunk-lines',
        min: 10,
        max: 1000
    },
    {
        id: 'project-memory-max-compact-summary-chars',
        key: 'project_memory_maintenance.max_compact_summary_chars',
        label: 'Project-memory compact summary chars',
        description: 'Tune the maximum generated compact project-memory summary size.',
        flag: '--project-memory-max-compact-summary-chars',
        min: 2000,
        max: 200000
    },
    {
        id: 'project-memory-impact-retention-days',
        key: 'project_memory_maintenance.impact_artifact_retention_days',
        label: 'Project-memory impact retention days',
        description: 'Tune how long project-memory impact artifacts are retained.',
        flag: '--project-memory-impact-artifact-retention-days',
        min: 1,
        max: 3650
    }
] as const;

export function buildUiSettingDefinitions(repoRoot: string): UiSettingDefinition[] {
    const settings = buildWorkflowConfigTab(repoRoot).settings;
    return UI_SETTING_DEFINITIONS.map((definition) => ({
        ...definition,
        current_value: settings.find((setting) => setting.key === definition.key)?.value,
        value_type: 'integer',
        confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE
    }));
}

export function findSetting(settings: UiSettingDefinition[], settingId: unknown): UiSettingDefinition | null {
    if (typeof settingId !== 'string') {
        return null;
    }
    return settings.find((setting) => setting.id === settingId) || null;
}

export function parseUiSettingValue(setting: UiSettingDefinition, value: unknown): number {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/u.test(raw)) {
        throw new Error(`${setting.label} must be an integer.`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < setting.min || parsed > setting.max) {
        throw new Error(`${setting.label} must be an integer from ${setting.min} to ${setting.max}.`);
    }
    return parsed;
}

function buildUiSettingCommand(repoRoot: string, setting: UiSettingDefinition, value: number, timestampUtc: string): UiActionCommand {
    const cliPath = resolveGardaCliPath(repoRoot);
    const args = [
        'workflow',
        'set',
        setting.flag,
        String(value),
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

export function buildUiSettingAction(repoRoot: string, setting: UiSettingDefinition, value: number, timestampUtc: string): UiActionDefinition {
    return {
        id: `setting:${setting.id}`,
        label: setting.label,
        description: setting.description,
        mutates: true,
        requires_confirmation: true,
        confirmation_phrase: setting.confirmation_phrase,
        command: buildUiSettingCommand(repoRoot, setting, value, timestampUtc)
    };
}

function capOutput(value: string, maxChars = 32000): string {
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
        label: action.label,
        description: action.description,
        mutates: action.mutates,
        requires_confirmation: action.requires_confirmation,
        confirmation_phrase: action.confirmation_phrase,
        command: action.command.display
    };
}
