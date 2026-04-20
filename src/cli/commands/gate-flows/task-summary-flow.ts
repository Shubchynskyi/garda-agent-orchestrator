import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../../gates/helpers';
import { buildTaskEventsSummary, formatTaskEventsSummaryText } from '../../../gates/task-events-summary';
import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    synchronizeFinalCloseoutArtifacts
} from '../../../gates/task-audit-summary';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../cli-helpers';
import { requireResolvedPath } from '../shared-command-utils';

export interface TaskEventsSummaryCommandOptions {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    outputPath?: unknown;
    asJson?: unknown;
    includeDetails?: unknown;
}

export interface TaskEventsSummaryCommandResult {
    rendered: string;
}

export interface TaskAuditSummaryCommandOptions {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    outputPath?: unknown;
    asJson?: unknown;
}

export interface TaskAuditSummaryCommandResult {
    rendered: string;
    exitCode: number;
}

export function runTaskEventsSummaryCommand(
    options: TaskEventsSummaryCommandOptions
): TaskEventsSummaryCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true }),
            'EventsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const summary = buildTaskEventsSummary({
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        eventsRoot,
        repoRoot
    });
    const rendered = options.asJson === true
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `${formatTaskEventsSummaryText(summary, options.includeDetails === true)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    return { rendered };
}

export function runTaskAuditSummaryCommand(
    options: TaskAuditSummaryCommandOptions
): TaskAuditSummaryCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const auditSummary = buildTaskAuditSummary({
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        repoRoot,
        eventsRoot: options.eventsRoot ? String(options.eventsRoot) : null,
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null
    });
    synchronizeFinalCloseoutArtifacts(auditSummary);
    const rendered = options.asJson === true
        ? `${JSON.stringify(auditSummary, null, 2)}\n`
        : `${formatTaskAuditSummaryText(auditSummary)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    return {
        rendered,
        exitCode: auditSummary.status !== 'PASS' ? EXIT_GATE_FAILURE : 0
    };
}
