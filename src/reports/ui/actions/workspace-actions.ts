import { UI_ACTION_INSPECTION_TIMEOUT_MS, buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export const SYSTEM_STATE_DIAGNOSTIC_ACTION_IDS = Object.freeze(['status', 'doctor', 'status-why-blocked', 'repair-inspect'] as const);

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
