import type { ReviewCatalogManagementPlan } from './review-catalog-types';

export function formatReviewCatalogResult(result: Record<string, unknown>, jsonMode: boolean): string {
    if (jsonMode) return JSON.stringify(result, null, 2);
    const lines = ['GARDA_REVIEW_CATALOG'];
    for (const [key, value] of Object.entries(result)) {
        if (key === 'lanes' && Array.isArray(value)) {
            lines.push(`Lanes: ${value.map((lane) => (lane as { id: string }).id).join(', ') || 'none'}`);
            continue;
        }
        if (key === 'lane' && value && typeof value === 'object') {
            const lane = value as { id: string; display_label: string; capability_enabled: boolean };
            lines.push(`Lane: ${lane.id} (${lane.display_label}); capability=${lane.capability_enabled ? 'enabled' : 'disabled'}`);
            continue;
        }
        if (Array.isArray(value)) {
            lines.push(`${key}: ${value.length > 0 ? value.map((entry) => (
                typeof entry === 'string' ? entry : JSON.stringify(entry)
            )).join(' | ') : 'none'}`);
            continue;
        }
        if (value !== undefined && typeof value !== 'object') lines.push(`${key}: ${String(value)}`);
    }
    return lines.join('\n');
}

export function buildMutationCommandResult(
    plan: ReviewCatalogManagementPlan,
    transaction: {
        status: 'APPLIED' | 'NO_CHANGE';
        audit_path: string;
        backup_path: string | null;
        protected_manifest_path: string;
    } | null
): Record<string, unknown> {
    return {
        action: plan.operation,
        mode: transaction ? 'apply' : 'preview',
        status: transaction?.status ?? 'PREVIEW',
        review_id: plan.review_id,
        changed: plan.changed,
        before_state_sha256: plan.before_state_sha256,
        after_state_sha256: plan.after_state_sha256,
        plan_sha256: plan.plan_sha256,
        changed_files: plan.changes.map(({ relative_path }) => relative_path),
        diff: plan.diff,
        explanation: plan.explanation,
        task_effect: {
            scope: 'future_tasks_only',
            active_task_snapshots_changed: false
        },
        audit_path: transaction?.audit_path ?? null,
        backup_path: transaction?.backup_path ?? null,
        protected_manifest_path: transaction?.protected_manifest_path ?? null
    };
}
