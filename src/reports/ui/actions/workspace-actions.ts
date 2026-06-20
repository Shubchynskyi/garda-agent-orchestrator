import { UI_ACTION_CLEANUP_TIMEOUT_MS, UI_ACTION_INSPECTION_TIMEOUT_MS, buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export const SYSTEM_STATE_DIAGNOSTIC_ACTION_IDS = Object.freeze(['status', 'doctor', 'status-why-blocked', 'repair-inspect'] as const);
export const SYSTEM_STATE_REPAIR_ACTION_IDS = Object.freeze([
    'repair-rebuild-indexes',
    'repair-protected-manifest',
    'repair-locks-cleanup-stale'
] as const);

export function buildUiWorkspaceActionDefinitions(repoRoot: string): UiActionDefinition[] {
    return [
        buildUiActionDefinition(
            repoRoot,
            'status',
            'Inspection',
            'Status',
            'Show current Garda workspace status without changing files.',
            ['status', '--target-root', repoRoot],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'doctor',
            'Inspection',
            'Doctor',
            'Run read-only Garda diagnostics for init answers, manifests, generated files, locks, and package state.',
            ['doctor', '--target-root', repoRoot, '--dry-run'],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'status-why-blocked',
            'Inspection',
            'Why blocked',
            'Explain why visible tasks are blocked without changing files.',
            ['status', 'why-blocked', '--target-root', repoRoot],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'repair-inspect',
            'Inspection',
            'Repair inspect',
            'Inspect canonical and derived runtime state without rebuilding or deleting files.',
            ['repair', 'inspect', '--target-root', repoRoot],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'repair-rebuild-indexes',
            'Repair',
            'Rebuild indexes',
            'Rebuild derived task timeline and review indexes from canonical runtime evidence.',
            ['repair', 'rebuild-indexes', '--target-root', repoRoot, '--confirm'],
            { mutates: true, confirmationPhrase: 'REBUILD GARDA INDEXES', timeoutMs: UI_ACTION_CLEANUP_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'repair-protected-manifest',
            'Repair',
            'Refresh protected manifest',
            'Refresh the trusted protected control-plane manifest from the current workspace snapshot.',
            ['repair', 'protected-manifest', '--target-root', repoRoot, '--confirm'],
            { mutates: true, confirmationPhrase: 'REFRESH PROTECTED MANIFEST', timeoutMs: UI_ACTION_CLEANUP_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'repair-locks-cleanup-stale',
            'Repair',
            'Clean up stale locks',
            'Remove only task-event and review-artifact locks that Garda classifies as stale.',
            ['repair', 'locks', '--target-root', repoRoot, '--cleanup-stale', '--confirm'],
            { mutates: true, confirmationPhrase: 'CLEAN UP STALE LOCKS', timeoutMs: UI_ACTION_CLEANUP_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'garda-off',
            'Garda switch',
            'Turn Garda Off',
            'Move managed Garda root instruction files into inactive switch storage.',
            ['off', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA OFF' }
        ),
        buildUiActionDefinition(
            repoRoot,
            'garda-on',
            'Garda switch',
            'Turn Garda On',
            'Restore managed Garda root instruction files from switch storage.',
            ['on', '--target-root', repoRoot],
            { mutates: true, confirmationPhrase: 'TURN GARDA ON' }
        )
    ];
}
