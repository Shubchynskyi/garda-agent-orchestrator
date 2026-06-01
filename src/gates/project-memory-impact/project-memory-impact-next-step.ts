import type { ProjectMemoryImpactStatus } from './project-memory-impact-types';

export function buildProjectMemoryImpactNextStep(
    status: ProjectMemoryImpactStatus,
    affectedMemoryFiles: readonly string[]
): string {
    switch (status) {
        case 'OFF':
            return 'Project memory maintenance is disabled; no memory evidence is required.';
        case 'NO_UPDATE_NEEDED':
            return 'No durable project-memory update is required for the current changed-file scope.';
        case 'UPDATED':
            return 'Project memory update evidence is current for the affected memory files.';
        case 'BLOCKED':
            return 'With explicit user approval, update the listed memory files and rerun project-memory-impact with --confirm-updated, or switch maintenance mode out of strict/update.';
        case 'UPDATE_NEEDED':
        default:
            return affectedMemoryFiles.length > 0
                ? 'With explicit user approval, update listed memory files when appropriate, then rerun with --confirm-updated; check mode remains advisory.'
                : 'Inspect project-memory diagnostics; check mode remains advisory.';
    }
}
