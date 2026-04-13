import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GENERAL_FAILURE
} from '../../exit-codes';
import {
    DEFAULT_GIT_TIMEOUT_MS,
    spawnStreamed
} from '../../../core/subprocess';
import {
    appendTaskEvent
} from '../../../gate-runtime/task-events';
import { assertValidTaskId } from '../../../gate-runtime/task-events';
import { auditCommandCompactness, auditGateCommand } from '../../../gates/task-events-summary';
import type { CommandCompactnessAudit } from '../../../gates/task-events-summary';
import * as gateHelpers from '../../../gates/helpers';
import {
    cleanupTerminalCompileLogs,
    resolvePathForWrite,
    type TerminalLogCleanupResult
} from '../gates-artifacts';
import {
    toCommandPolicyAuditSummary
} from '../gates-formatter';
import {
    parseJsonOption
} from '../gates-parser';
import { requireResolvedPath } from '../shared-command-utils';
import {
    resolveOrchestratorRoot,
    isPlainObject
} from './gate-flow-helpers';

type CommandPolicyAudit = CommandCompactnessAudit;

export interface LogTaskEventCommandOptions {
    repoRoot?: string;
    eventsRoot?: string;
    taskId?: unknown;
    eventType?: unknown;
    outcome?: unknown;
    actor?: unknown;
    message?: unknown;
    detailsJson?: unknown;
}

export interface HumanCommitOptions {
    cwd?: string;
}

interface CommandAuditPayload {
    command_text: string;
    mode: string;
    justification: string;
}

interface LogTaskEventCommandResult {
    status: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    task_event_log_path: string;
    all_tasks_log_path: string;
    integrity?: NonNullable<ReturnType<typeof appendTaskEvent>>['integrity'];
    warnings?: string[];
    command_policy_audit?: CommandPolicyAudit;
    terminal_log_cleanup?: TerminalLogCleanupResult;
}

function toDetailsMap(detailsObject: unknown): Record<string, unknown> {
    if (detailsObject == null) {
        return {};
    }
    if (isPlainObject(detailsObject)) {
        return { ...detailsObject };
    }
    return {
        input_details: detailsObject
    };
}

function getCommandAuditPayload(detailsObject: unknown): CommandAuditPayload | null {
    if (!isPlainObject(detailsObject)) {
        return null;
    }

    let commandText = '';
    for (const candidateKey of ['command', 'command_text', 'shell_command']) {
        const value = detailsObject[candidateKey];
        if (typeof value === 'string' && value.trim()) {
            commandText = value.trim();
            break;
        }
    }
    if (!commandText) {
        return null;
    }

    return {
        command_text: commandText,
        mode: String(detailsObject.command_mode || detailsObject.mode || 'scan'),
        justification: String(detailsObject.command_justification || detailsObject.justification || '')
    };
}

export function runLogTaskEventCommand(options: LogTaskEventCommandOptions): { outputText: string; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(resolvePathForWrite(options.eventsRoot, repoRoot), 'EventsRoot')
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const eventType = String(options.eventType || '').trim();
    const outcome = String(options.outcome || 'INFO').trim().toUpperCase();
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const message = String(options.message || '');
    const details = parseJsonOption(options.detailsJson || '', 'DetailsJson');

    if (!eventType) {
        throw new Error('EventType must not be empty.');
    }
    if (!['INFO', 'PASS', 'FAIL', 'BLOCKED'].includes(outcome)) {
        throw new Error(`Outcome must be one of INFO, PASS, FAIL, BLOCKED. Got '${outcome}'.`);
    }
    if (eventType === 'TASK_MODE_ENTERED' || /^(COMPILE_GATE_|REVIEW_GATE_|PREFLIGHT_|COMPLETION_GATE_)/.test(eventType)) {
        throw new Error(`EventType '${eventType}' is reserved and cannot be emitted via log-task-event.`);
    }

    fs.mkdirSync(eventsRoot, { recursive: true });

    let eventDetails: unknown = details;
    let terminalLogCleanup: TerminalLogCleanupResult = {
        triggered: false,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        missing_paths: [],
        errors: []
    };
    const isTerminalEvent = eventType === 'TASK_DONE' || eventType === 'TASK_BLOCKED';
    if (isTerminalEvent) {
        terminalLogCleanup = cleanupTerminalCompileLogs(repoRoot, taskId);
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.terminal_log_cleanup = terminalLogCleanup;
        eventDetails = detailsMap;
    }

    let commandCompactnessAudit: CommandPolicyAudit | null = null;
    const auditPayload = getCommandAuditPayload(eventDetails);
    if (auditPayload) {
        commandCompactnessAudit = auditCommandCompactness(auditPayload.command_text, {
            mode: auditPayload.mode,
            justification: auditPayload.justification
        });
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.command_policy_audit = commandCompactnessAudit;
        eventDetails = detailsMap;
    }

    const appendResult = appendTaskEvent(
        orchestratorRoot,
        taskId,
        eventType,
        outcome,
        message,
        eventDetails,
        {
            actor,
            passThru: true,
            eventsRoot
        }
    );
    const result: LogTaskEventCommandResult = {
        status: 'TASK_EVENT_LOGGED',
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor,
        task_event_log_path: gateHelpers.normalizePath(path.join(eventsRoot, `${taskId}.jsonl`)),
        all_tasks_log_path: gateHelpers.normalizePath(path.join(eventsRoot, 'all-tasks.jsonl'))
    };

    if (appendResult && isPlainObject(appendResult.integrity)) {
        result.integrity = appendResult.integrity;
    }
    if (appendResult && Array.isArray(appendResult.warnings) && appendResult.warnings.length > 0) {
        result.warnings = [...appendResult.warnings];
    }
    if (commandCompactnessAudit) {
        result.command_policy_audit = commandCompactnessAudit;
        const auditSummary = toCommandPolicyAuditSummary(commandCompactnessAudit);
        if (auditSummary.warning_count > 0) {
            result.warnings = [...(result.warnings || []), ...auditSummary.warnings];
        }
    }
    if (isTerminalEvent) {
        result.terminal_log_cleanup = terminalLogCleanup;
    }

    const cleanupFailed = isTerminalEvent && terminalLogCleanup.errors.length > 0;
    if (cleanupFailed) {
        result.status = 'TASK_EVENT_LOGGED_CLEANUP_FAILED';
    }

    return {
        outputText: `${JSON.stringify(result, null, 2)}\n`,
        exitCode: cleanupFailed ? EXIT_GENERAL_FAILURE : 0
    };
}

export async function runHumanCommitCommand(gitArgs: unknown, options: HumanCommitOptions = {}): Promise<number> {
    const finalArgs = gateHelpers.toStringArray(gitArgs).filter(function (item: string) {
        return String(item || '').trim() !== '';
    });
    if (finalArgs.length === 0) {
        throw new Error('Provide git commit arguments, for example: -m "feat: message"');
    }

    const result = await spawnStreamed('git', ['commit', ...finalArgs], {
        cwd: options.cwd || process.cwd(),
        inheritStdio: true,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        env: { GARDA_ALLOW_COMMIT: '1' }
    });

    return result.exitCode;
}
