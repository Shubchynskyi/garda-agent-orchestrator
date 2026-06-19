import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const CLEANUP_SETTING_TEXT_IDS = Object.freeze([
    'tab_intro',
    'daily_maintenance_enabled',
    'daily_maintenance_max_tasks_per_run',
    'eligible_older_than_days',
    'keep_latest_tasks',
    'daily_maintenance_dry_run',
    'purge_require_confirm',
    'healthy_done_compact_after_days',
    'problem_tasks_compress_after_days',
    'manual_runtime_cleanup',
    'task_purge',
    'task_id',
    'purge_task_button',
    'run_preview',
    'value_true',
    'value_false'
] as const);

export type CleanupSettingTextId = typeof CLEANUP_SETTING_TEXT_IDS[number];

export function buildCleanupSettingTextCatalog(): Readonly<Record<CleanupSettingTextId, LocalUiLocalizedText>> {
    return Object.freeze({
        tab_intro: {
            description: 'Runtime retention policy in runtime-retention.json: scheduled maintenance thresholds, compaction rules, and guarded manual cleanup actions.'
        },
        daily_maintenance_enabled: {
            label: 'Daily maintenance',
            description: 'Turns scheduled daily maintenance on or off. When enabled, the orchestrator can process a limited batch of eligible tasks on a schedule without manual intervention.'
        },
        daily_maintenance_max_tasks_per_run: {
            label: 'Max tasks per maintenance run',
            description: 'Upper bound on how many eligible tasks daily maintenance processes in a single run. Limits blast radius if thresholds are misconfigured.'
        },
        eligible_older_than_days: {
            label: 'Minimum task age (days)',
            description: 'A task must be at least this many days old before maintenance or manual cleanup may touch its runtime artifacts. Active tasks and newer tasks stay protected.'
        },
        keep_latest_tasks: {
            label: 'Keep newest tasks (count)',
            description: 'Always preserve at least this many most-recent tasks even if they are older than the age threshold. Set 0 to rely only on age and active-task protection.'
        },
        daily_maintenance_dry_run: {
            label: 'Daily maintenance dry-run',
            description: 'When true, scheduled daily maintenance only lists candidates and writes audit output; it does not delete or compress artifacts. Use true while tuning thresholds, then switch to false to apply.'
        },
        purge_require_confirm: {
            label: 'Automatic cleanup confirmation safeguard',
            description: 'When true, scheduled or CLI destructive cleanup remains confirmation-gated instead of running silently. Manual UI cleanup and task-artifact cleanup always require their own typed confirmation phrases.'
        },
        healthy_done_compact_after_days: {
            label: 'Compress healthy DONE after (days)',
            description: 'After this many days, successfully completed (DONE) tasks may be compressed to ledger-only history once ledger evidence is verified.'
        },
        problem_tasks_compress_after_days: {
            label: 'Compress problem tasks after (days)',
            description: 'After this many days, failed or stuck tasks may have heavy forensic artifacts compressed while keeping recovery-readable evidence.'
        },
        manual_runtime_cleanup: {
            label: 'Manual runtime cleanup',
            description: 'Runs garda cleanup once with the age and keep-latest values from the rows above. Preview is a dry-run that only shows candidates; Apply deletes or compresses according to policy and requires typed confirmation.'
        },
        task_purge: {
            label: 'Task runtime artifact cleanup',
            description: 'Removes runtime artifacts owned by one task ID and repairs shared indexes. It does not remove whole shared files; active-task protection still applies on the server.'
        },
        task_id: {
            label: 'Task ID'
        },
        purge_task_button: {
            label: 'Clean task runtime artifacts'
        },
        run_preview: {
            label: 'Preview dry-run'
        },
        value_true: {
            label: 'true — enabled'
        },
        value_false: {
            label: 'false — disabled'
        }
    });
}

export function listCleanupSettingTextCatalogIds(
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildCleanupSettingTextCatalog()
): string[] {
    return Object.keys(catalog).sort();
}
