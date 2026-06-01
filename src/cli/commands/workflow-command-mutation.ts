import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { writeProtectedControlPlaneManifest } from '../../gates/protected-control-plane/protected-control-plane';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import type { WorkflowFileConfigData } from './workflow-command-types';

export function getWorkflowConfigField(config: WorkflowFileConfigData, fieldPath: string): unknown {
    return fieldPath.split('.').reduce<unknown>((current, segment) => {
        if (current && typeof current === 'object' && segment in current) {
            return (current as Record<string, unknown>)[segment];
        }
        return undefined;
    }, config);
}

export function workflowConfigValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveActualChangedFields(
    requestedFields: readonly string[],
    currentConfig: WorkflowFileConfigData,
    nextConfig: WorkflowFileConfigData,
    configExists: boolean
): string[] {
    if (!configExists) {
        return [...requestedFields];
    }
    return requestedFields.filter((field) => !workflowConfigValuesEqual(
        getWorkflowConfigField(currentConfig, field),
        getWorkflowConfigField(nextConfig, field)
    ));
}

export function writeWorkflowConfig(configPath: string, config: WorkflowFileConfigData): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateWorkflowConfig(config) as WorkflowFileConfigData;
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

export function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeOutputPath(value: string): string {
    return path.normalize(value).replace(/\\/g, '/');
}

export function writeWorkflowConfigAuditRecord(
    bundleRoot: string,
    configPath: string,
    changedFields: string[],
    beforeText: string,
    afterText: string
): string {
    const auditPath = path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify({
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: new Date().toISOString(),
        actor: 'operator_command',
        command: 'workflow set',
        config_path: normalizeOutputPath(configPath),
        changed_fields: changedFields,
        before_sha256: sha256Text(beforeText),
        after_sha256: sha256Text(afterText)
    }) + '\n', 'utf8');
    return auditPath;
}

export function refreshWorkflowProtectedManifest(targetRoot: string): string {
    return writeProtectedControlPlaneManifest(targetRoot);
}
