import {
    UI_ACTION_CLEANUP_TIMEOUT_MS,
    UI_ACTION_HTML_REPORT_TIMEOUT_MS,
    UI_ACTION_INSPECTION_TIMEOUT_MS,
    buildUiActionDefinition
} from './action-common';
import type { UiActionDefinition } from './types';

export function buildUiWorkspaceActionDefinitions(repoRoot: string): UiActionDefinition[] {
    return [
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
        ),
        buildUiActionDefinition(
            repoRoot,
            'status',
            'Inspection',
            'Status',
            'Run the existing Garda status command for this workspace.',
            ['status', '--target-root', repoRoot],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'doctor',
            'Inspection',
            'Doctor',
            'Run Garda workspace diagnostics, including init answers, manifests, generated files, locks, and bundle health. This is read-only unless explicit cleanup flags are added elsewhere.',
            ['doctor', '--target-root', repoRoot],
            { timeoutMs: UI_ACTION_INSPECTION_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'html-report',
            'Export',
            'Generate HTML Report',
            'Run the existing Garda html command with lazy task details.',
            ['html', '--target-root', repoRoot, '--max-detailed-tasks', '0'],
            { mutates: true, confirmationPhrase: 'RUN GARDA HTML', timeoutMs: UI_ACTION_HTML_REPORT_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'cleanup-preview',
            'Maintenance',
            'Preview Runtime Cleanup',
            'Dry-run runtime cleanup. Shows candidate task events, reviews, reports, backups, rollbacks, metrics, and working plans that match retention limits. Nothing is deleted.',
            ['cleanup', '--target-root', repoRoot, '--dry-run'],
            { timeoutMs: UI_ACTION_CLEANUP_TIMEOUT_MS }
        ),
        buildUiActionDefinition(
            repoRoot,
            'cleanup-apply',
            'Maintenance',
            'Apply Runtime Cleanup',
            'Applies the same retention cleanup shown by preview. Risk: old runtime evidence can be removed or compressed, so review the preview first and do not run while another task is active.',
            ['cleanup', '--target-root', repoRoot, '--confirm'],
            { mutates: true, confirmationPhrase: 'RUN GARDA CLEANUP', timeoutMs: UI_ACTION_CLEANUP_TIMEOUT_MS }
        )
    ];
}
