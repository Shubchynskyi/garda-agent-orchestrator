import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { buildDefaultWorkflowConfig } from './workflow-config';
import { joinOrchestratorPath } from '../gates/shared/helpers';
import { validateWorkflowConfig } from '../schemas/config-artifacts';

export interface TaskResetAvailability {
    enabled: boolean;
    configuredEnabled: boolean;
    auditedEnablement: boolean;
    configPath: string;
    disabledReason: string | null;
    remediationCommand: string;
}

interface WorkflowConfigAuditRecord {
    event_source?: unknown;
    command?: unknown;
    changed_fields?: unknown;
    before_sha256?: unknown;
    after_sha256?: unknown;
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function recordChangedTaskResetEnabled(record: WorkflowConfigAuditRecord): boolean {
    return Array.isArray(record.changed_fields)
        && record.changed_fields.some((field) => String(field || '').trim() === 'task_reset.enabled');
}

function readWorkflowConfigAuditRecords(auditPath: string): WorkflowConfigAuditRecord[] {
    if (!fileExists(auditPath)) {
        return [];
    }

    const records: WorkflowConfigAuditRecord[] = [];
    for (const line of fs.readFileSync(auditPath, 'utf8').split(/\r?\n/u)) {
        if (!line.trim()) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as unknown;
            if (isPlainRecord(parsed)) {
                records.push(parsed as WorkflowConfigAuditRecord);
            }
        } catch {
            // Ignore malformed legacy audit rows; they cannot authorize reset.
        }
    }
    return records;
}

export function hasAuditedTaskResetEnablement(repoRoot: string, currentConfigSha256: string): boolean {
    const auditPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'workflow-config-audit.jsonl'));
    const recordsByAfterHash = new Map<string, WorkflowConfigAuditRecord>();
    for (const record of readWorkflowConfigAuditRecords(auditPath)) {
        if (String(record.event_source || '') !== 'workflow-config-set') {
            continue;
        }
        if (String(record.command || '') !== 'workflow set') {
            continue;
        }
        const afterSha256 = normalizeSha256(record.after_sha256);
        if (afterSha256) {
            recordsByAfterHash.set(afterSha256, record);
        }
    }

    const visited = new Set<string>();
    let cursor: string | null = currentConfigSha256;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const record = recordsByAfterHash.get(cursor);
        if (!record) {
            return false;
        }
        if (recordChangedTaskResetEnabled(record)) {
            return true;
        }
        cursor = normalizeSha256(record.before_sha256);
    }
    return false;
}

function buildRemediationCommand(): string {
    return 'garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"';
}

export function resolveTaskResetAvailability(repoRoot: string): TaskResetAvailability {
    const configPath = joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
    const remediationCommand = buildRemediationCommand();
    if (!fileExists(configPath)) {
        return {
            enabled: false,
            configuredEnabled: false,
            auditedEnablement: false,
            configPath,
            disabledReason: 'workflow-config.json is missing',
            remediationCommand
        };
    }

    try {
        const configText = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(configText) as unknown;
        const validated = validateWorkflowConfig(parsed);
        const defaultTaskReset = buildDefaultWorkflowConfig().task_reset as unknown as Record<string, unknown>;
        const taskReset = isPlainRecord(validated.task_reset)
            ? validated.task_reset
            : defaultTaskReset;
        const configuredEnabled = taskReset.enabled === true;
        const auditedEnablement = configuredEnabled
            ? hasAuditedTaskResetEnablement(repoRoot, sha256Text(configText))
            : false;
        if (configuredEnabled && !auditedEnablement) {
            return {
                enabled: false,
                configuredEnabled,
                auditedEnablement,
                configPath,
                disabledReason: 'workflow-config.task_reset.enabled is true but no matching audited workflow set record was found',
                remediationCommand
            };
        }
        return {
            enabled: configuredEnabled,
            configuredEnabled,
            auditedEnablement,
            configPath,
            disabledReason: configuredEnabled ? null : 'workflow-config.task_reset.enabled is false',
            remediationCommand
        };
    } catch (error: unknown) {
        return {
            enabled: false,
            configuredEnabled: false,
            auditedEnablement: false,
            configPath,
            disabledReason: `workflow-config.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
            remediationCommand
        };
    }
}
