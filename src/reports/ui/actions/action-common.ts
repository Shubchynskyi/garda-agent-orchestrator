import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleNameForTarget } from '../../../core/constants';
import { spawnStreamed } from '../../../core/subprocess';
import type {
    UiActionAuditRecord,
    UiActionCommand,
    UiActionDefinition,
    UiActionRunnerResult,
    UiSwitchModeState
} from './types';

export function quoteCommandPart(value: string): string {
    return /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

export function resolveGardaCliPath(repoRoot: string): string {
    const sourceCliPath = path.join(repoRoot, 'bin', 'garda.js');
    if (fs.existsSync(sourceCliPath)) {
        return sourceCliPath;
    }
    return path.join(resolveBundleRoot(repoRoot), 'bin', 'garda.js');
}

export function resolveBundleRoot(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
}

export function displayGardaCommand(repoRoot: string, cliPath: string, args: string[]): string {
    const relativeCliPath = path.relative(repoRoot, cliPath).replace(/\\/gu, '/') || cliPath;
    const displayArgs = args.map((argument) => argument === repoRoot ? '.' : argument);
    return ['node', relativeCliPath, ...displayArgs].map(quoteCommandPart).join(' ');
}

export interface UiActionBuildOptions {
    mutates?: boolean;
    confirmationPhrase?: string;
    enabled?: boolean;
    unavailableReason?: string;
    timeoutMs?: number;
}

export const UI_ACTION_DEFAULT_TIMEOUT_MS = 60_000;
export const UI_ACTION_INSPECTION_TIMEOUT_MS = 120_000;
export const UI_ACTION_HTML_REPORT_TIMEOUT_MS = 180_000;
export const UI_ACTION_CLEANUP_TIMEOUT_MS = 180_000;
export const UI_ACTION_ROLLBACK_TIMEOUT_MS = 300_000;
export const UI_ACTION_HARD_KILL_GRACE_MS = 3_000;
export const UI_ACTION_WINDOWS_CLEANUP_METHOD = 'taskkill /T /F';

export function buildUiActionDefinition(
    repoRoot: string,
    id: string,
    category: string,
    label: string,
    description: string,
    args: string[],
    options: UiActionBuildOptions = {}
): UiActionDefinition {
    const cliPath = resolveGardaCliPath(repoRoot);
    return {
        id,
        category,
        label,
        description,
        mutates: options.mutates === true,
        enabled: options.enabled !== false,
        unavailable_reason: options.enabled === false
            ? options.unavailableReason || 'Action is unavailable.'
            : null,
        requires_confirmation: Boolean(options.confirmationPhrase),
        confirmation_phrase: options.confirmationPhrase || null,
        timeout_ms: options.timeoutMs ?? UI_ACTION_DEFAULT_TIMEOUT_MS,
        command: {
            executable: process.execPath,
            args: [cliPath, ...args],
            display: displayGardaCommand(repoRoot, cliPath, args)
        }
    };
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

export function normalizeUiActionTimeoutMs(action: UiActionDefinition): number {
    return Number.isFinite(action.timeout_ms) && action.timeout_ms > 0
        ? Math.trunc(action.timeout_ms)
        : UI_ACTION_DEFAULT_TIMEOUT_MS;
}

export function normalizeUiActionRunnerResult(action: UiActionDefinition, result: UiActionRunnerResult): UiActionRunnerResult {
    return {
        exit_code: result.exit_code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timed_out === true,
        timeout_ms: result.timeout_ms ?? normalizeUiActionTimeoutMs(action)
    };
}

export function formatUiActionTimeoutMessage(timeoutMs: number): string {
    if (process.platform === 'win32') {
        return `Process timed out after ${timeoutMs} ms; subprocess tree cleanup requested via ${UI_ACTION_WINDOWS_CLEANUP_METHOD}.`;
    }
    return `Process timed out after ${timeoutMs} ms; subprocess tree cleanup requested with hard-kill grace ${UI_ACTION_HARD_KILL_GRACE_MS} ms.`;
}

export function uiActionHttpStatus(result: UiActionRunnerResult): number {
    if (result.timed_out === true) {
        return 504;
    }
    return result.exit_code === 0 ? 200 : 500;
}

export function uiActionExecutionPayload(result: UiActionRunnerResult): Record<string, unknown> {
    return {
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out === true,
        timeout_ms: result.timeout_ms,
        stdout: result.stdout,
        stderr: result.stderr
    };
}

export function uiActionExecutionAuditFields(result: UiActionRunnerResult): Pick<UiActionAuditRecord, 'exit_code' | 'signal' | 'timed_out' | 'timeout_ms'> {
    return {
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out === true,
        timeout_ms: result.timeout_ms
    };
}

export async function runUiActionCommand(action: UiActionDefinition, repoRoot: string): Promise<UiActionRunnerResult> {
    const timeoutMs = normalizeUiActionTimeoutMs(action);
    const result = await spawnStreamed(action.command.executable, action.command.args, {
        cwd: repoRoot,
        env: buildUiActionEnv(),
        envMode: 'replace',
        timeoutMs,
        maxBuffer: 512000
    });
    return {
        exit_code: result.exitCode,
        signal: null,
        stdout: capOutput(result.stdout),
        stderr: result.timedOut
            ? capOutput(`${result.stderr}${result.stderr ? '\n' : ''}${formatUiActionTimeoutMessage(timeoutMs)}`)
            : capOutput(result.stderr),
        timed_out: result.timedOut,
        timeout_ms: timeoutMs
    };
}

function getUiActionAuditPath(repoRoot: string): string {
    return path.join(resolveBundleRoot(repoRoot), 'runtime', 'ui-actions', 'audit.jsonl');
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
        enabled: action.enabled,
        unavailable_reason: action.unavailable_reason,
        requires_confirmation: action.requires_confirmation,
        confirmation_phrase: action.confirmation_phrase,
        timeout_ms: action.timeout_ms,
        command: action.command.display
    };
}

export function buildUiActionCommand(
    repoRoot: string,
    args: string[]
): UiActionCommand {
    const cliPath = resolveGardaCliPath(repoRoot);
    return {
        executable: process.execPath,
        args: [cliPath, ...args],
        display: displayGardaCommand(repoRoot, cliPath, args)
    };
}
