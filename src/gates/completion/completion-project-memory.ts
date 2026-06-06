import { normalizePath } from '../shared/helpers';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    type ProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact/project-memory-impact';
import {
    findLatestTimelineEvent,
    type TimelineEventEntry
} from './completion-evidence';

export function validateProjectMemoryImpactForCompletion(input: {
    evidence: ProjectMemoryImpactLifecycleEvidence;
    orderedEvents: readonly TimelineEventEntry[];
    fullSuiteValidationEnabled: boolean;
    timelinePath: string;
    docImpactEvidence?: Record<string, unknown> | null;
}): string[] {
    const violations: string[] = [];
    if (!input.evidence.required) {
        return violations;
    }
    if (input.evidence.evidence_status !== 'CURRENT') {
        violations.push(
            `Project memory impact evidence is not current before completion: ${input.evidence.evidence_status}. ` +
            `${input.evidence.visible_summary_line}`
        );
        violations.push(...input.evidence.violations);
        return violations;
    }
    if (input.docImpactEvidence?.project_memory_updated === true && input.evidence.status !== 'UPDATED') {
        violations.push(
            'Doc impact evidence claims project_memory_updated=true, but project-memory-impact did not record UPDATED evidence for the current completion cycle. ' +
            `${input.evidence.visible_summary_line}`
        );
    }
    if (input.docImpactEvidence?.project_memory_update_not_needed === true && input.evidence.status !== 'NO_UPDATE_NEEDED') {
        violations.push(
            'Doc impact evidence claims project_memory_update_not_needed=true, but project-memory-impact did not record NO_UPDATE_NEEDED evidence for the current completion cycle. ' +
            `${input.evidence.visible_summary_line}`
        );
    }

    const impactEvent = findLatestTimelineEvent(
        input.orderedEvents,
        (entry) => entry.event_type === PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    );
    if (!impactEvent) {
        violations.push(`Task timeline '${normalizePath(input.timelinePath)}' is missing ${PROJECT_MEMORY_IMPACT_ASSESSED_EVENT}.`);
        return violations;
    }

    const docImpactEvent = findLatestTimelineEvent(
        input.orderedEvents,
        (entry) => entry.event_type === 'DOC_IMPACT_ASSESSED'
    );
    if (docImpactEvent && impactEvent.sequence <= docImpactEvent.sequence) {
        violations.push('Project memory impact evidence must be recorded after doc-impact-gate for the current completion cycle.');
    }
    if (input.fullSuiteValidationEnabled) {
        const fullSuiteEvent = findLatestTimelineEvent(
            input.orderedEvents,
            (entry) => entry.event_type === 'FULL_SUITE_VALIDATION_PASSED'
                || entry.event_type === 'FULL_SUITE_VALIDATION_WARNED'
                || entry.event_type === 'FULL_SUITE_VALIDATION_SKIPPED'
        );
        if (!fullSuiteEvent) {
            violations.push('Project memory impact evidence requires current full-suite validation evidence when full-suite validation is enabled.');
        } else if (impactEvent.sequence <= fullSuiteEvent.sequence) {
            violations.push('Project memory impact evidence must be recorded after full-suite validation for the current completion cycle.');
        }
    }
    return violations;
}
