import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { resolveBundleNameForTarget } from '../../../core/constants';
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
    return path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js');
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
}

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
        enabled: action.enabled,
        unavailable_reason: action.unavailable_reason,
        requires_confirmation: action.requires_confirmation,
        confirmation_phrase: action.confirmation_phrase,
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
