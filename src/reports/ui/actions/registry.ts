export * from './types';
export * from './action-common';
export * from './workspace-actions';
export * from './task-actions';
export * from './workflow-setting-actions';
export * from './backup-actions';
export * from './cleanup-settings-actions';

import { buildUiBackupActionDefinitions } from './backup-actions';
import { buildUiWorkspaceActionDefinitions } from './workspace-actions';
import type { UiActionDefinition } from './types';

/** Workspace-level allow-listed actions exposed on `/api/actions`. */
export function buildUiWorkspaceAndBackupActionDefinitions(repoRoot: string): UiActionDefinition[] {
    return [
        ...buildUiWorkspaceActionDefinitions(repoRoot),
        ...buildUiBackupActionDefinitions(repoRoot)
    ];
}

/** @deprecated Use {@link buildUiWorkspaceAndBackupActionDefinitions} for clarity. */
export function buildUiActionDefinitions(repoRoot: string): UiActionDefinition[] {
    return buildUiWorkspaceAndBackupActionDefinitions(repoRoot);
}
