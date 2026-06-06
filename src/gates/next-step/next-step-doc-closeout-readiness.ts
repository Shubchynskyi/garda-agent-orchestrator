import * as path from 'node:path';

import {
    type ProjectMemoryImpactEvidenceStatus,
    type ProjectMemoryImpactStatus,
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact/project-memory-impact';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    collectOrderedTimelineEvents
} from '../completion/completion-evidence';
import {
    normalizePath
} from '../shared/helpers';
import {
    describePathList,
    stringSha256,
    type PreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    quoteCommandValue
} from './next-step-command-formatters';
import {
    findLatestTimelineEvent
} from './next-step-timeline-readers';

export interface NextStepProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
}

export interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
}

export interface PreflightCycleReadinessOptions {
    allowStaleCompletionFailureForDocCloseout?: boolean;
    staleCompletionFailureDocCloseoutReason?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasPassedDocImpactArtifact(docImpactPath: string | null | undefined): boolean {
    if (!docImpactPath) {
        return false;
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return false;
    }
    return String(docImpact.status || '').trim().toUpperCase() === 'PASSED'
        && String(docImpact.outcome || '').trim().toUpperCase() === 'PASS';
}

function docImpactTimelineDetailsMatchArtifact(
    details: Record<string, unknown> | null,
    docImpact: Record<string, unknown>,
    taskId: string,
    preflightPath: string,
    preflightSha256: string
): boolean {
    if (!details) {
        return false;
    }
    const expectedDocsUpdated = Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    const actualDocsUpdated = Array.isArray(details.docs_updated)
        ? details.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    return String(details.task_id || '').trim() === taskId
        && normalizePath(String(details.preflight_path || '').trim()) === normalizePath(preflightPath)
        && String(details.preflight_hash_sha256 || '').trim().toLowerCase() === preflightSha256
        && String(details.decision || '').trim().toUpperCase() === String(docImpact.decision || '').trim().toUpperCase()
        && String(details.status || '').trim().toUpperCase() === String(docImpact.status || '').trim().toUpperCase()
        && String(details.outcome || '').trim().toUpperCase() === String(docImpact.outcome || '').trim().toUpperCase()
        && details.behavior_changed === docImpact.behavior_changed
        && details.changelog_updated === docImpact.changelog_updated
        && details.internal_changelog_updated === docImpact.internal_changelog_updated
        && details.project_memory_updated === docImpact.project_memory_updated
        && stringSha256(actualDocsUpdated.join('\n')) === stringSha256(expectedDocsUpdated.join('\n'));
}

function getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    docImpactPath: string | null | undefined
): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return [];
    }
    if (String(docImpact.task_id || '').trim() !== taskId) {
        return [];
    }
    const evidencePreflightPath = normalizePath(String(docImpact.preflight_path || '').trim());
    const expectedPreflightPath = normalizePath(preflightPath);
    if (!evidencePreflightPath || evidencePreflightPath !== expectedPreflightPath) {
        return [];
    }
    const evidencePreflightHash = String(docImpact.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!preflightSha256 || !evidencePreflightHash || evidencePreflightHash !== preflightSha256) {
        return [];
    }
    const decision = String(docImpact.decision || '').trim().toUpperCase();
    const status = String(docImpact.status || '').trim().toUpperCase();
    const outcome = String(docImpact.outcome || '').trim().toUpperCase();
    if (
        decision !== 'DOCS_UPDATED'
        || status !== 'PASSED'
        || outcome !== 'PASS'
        || docImpact.behavior_changed !== false
    ) {
        return [];
    }
    const docsUpdated = Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    if (docsUpdated.length === 0) {
        return [];
    }
    const classificationConfig = getClassificationConfig(repoRoot);
    if (docsUpdated.some((entry) => !isOrdinaryDocumentationDeltaPath(entry, classificationConfig))) {
        return [];
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return [];
    }
    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    const latestDocImpactAssessed = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'DOC_IMPACT_ASSESSED'
    );
    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (
        !latestPreflight
        || !latestDocImpactAssessed
        || !latestCompletionFailure
        || !docImpactTimelineDetailsMatchArtifact(
            latestDocImpactAssessed.details,
            docImpact,
            taskId,
            preflightPath,
            preflightSha256
        )
        || latestDocImpactAssessed.sequence < latestPreflight.sequence
        || latestDocImpactAssessed.sequence < latestCompletionFailure.sequence
    ) {
        return [];
    }
    return docsUpdated;
}

export function buildStaleCompletionFailureDocCloseoutAllowance(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightWorkspaceReadiness: PreflightWorkspaceReadiness,
    docImpactPath: string
): PreflightCycleReadinessOptions {
    if (!preflightWorkspaceReadiness.ready) {
        return {};
    }
    if (hasPassedDocImpactArtifact(docImpactPath)) {
        const docImpactUpdatedFiles = getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            docImpactPath
        );
        if (docImpactUpdatedFiles.length > 0) {
            return {
                allowStaleCompletionFailureForDocCloseout: true,
                staleCompletionFailureDocCloseoutReason:
                    `latest doc-impact evidence records ordinary documentation updates ${describePathList(docImpactUpdatedFiles)} with behavior_changed=false`
            };
        }
        return {};
    }
    const acceptedDeltaFiles = [
        ...(preflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []),
        ...(preflightWorkspaceReadiness.acceptedCloseoutOnlyDeltaFiles || [])
    ];
    if (acceptedDeltaFiles.length > 0) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason:
                `current workspace drift is limited to ordinary documentation/closeout updates ${describePathList(acceptedDeltaFiles)}`
        };
    }
    return {};
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

export function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string,
    options: PreflightCycleReadinessOptions = {}
): PreflightCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestPreflight.sequence < latestTaskMode.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest TASK_MODE_ENTERED event (preflight seq ${latestPreflight.sequence}, task-mode seq ${latestTaskMode.sequence}). Refresh classify-change for the current task-mode cycle.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );
    if (latestShellSmoke && latestPreflight.sequence < latestShellSmoke.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest SHELL_SMOKE_PREFLIGHT_RECORDED event (preflight seq ${latestPreflight.sequence}, shell-smoke seq ${latestShellSmoke.sequence}). Refresh classify-change before compile/review/completion.`
        };
    }

    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (latestCompletionFailure && latestPreflight.sequence < latestCompletionFailure.sequence) {
        if (options.allowStaleCompletionFailureForDocCloseout) {
            return {
                ready: true,
                reason:
                    `Preflight evidence predates latest COMPLETION_GATE_FAILED (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}), ` +
                    `but the closeout lane remains current because ${options.staleCompletionFailureDocCloseoutReason || 'only ordinary documentation closeout evidence changed'}.`
            };
        }
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest COMPLETION_GATE_FAILED event (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}). Refresh classify-change for the resumed cycle.`
        };
    }

    return {
        ready: true,
        reason: 'Preflight evidence is current for the latest startup cycle.'
    };
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function requiresSensitiveScopeDocAcknowledgement(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    return ['api', 'security', 'infra', 'dependency', 'db'].some((trigger) => triggers[trigger] === true);
}

export function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function isChangelogPath(filePath: string): boolean {
    return /(^|\/)CHANGELOG/i.test(normalizePath(filePath));
}

function getDocImpactChangedFiles(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): string[] {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).filter((filePath) => (
        isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
}

function hasNonDocumentationPreflightScope(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): boolean {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).some((filePath) => (
        !isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
    ));
}

function shouldDefaultDocImpactBehaviorChanged(
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    docsUpdated: string[]
): boolean {
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    if (!changelogUpdated) {
        return false;
    }
    return hasNonDocumentationPreflightScope(preflight, repoRoot);
}

function shouldDefaultInternalOnlyBehaviorChanged(
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    docsUpdated: string[]
): boolean {
    return docsUpdated.length === 0 && hasNonDocumentationPreflightScope(preflight, repoRoot);
}

export function buildDocImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    additionalDocsUpdated: string[] = []
): string {
    const docsUpdated = [...new Set([
        ...getDocImpactChangedFiles(preflight, repoRoot),
        ...additionalDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean)
    ])].sort();
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    const behaviorChanged = shouldDefaultDocImpactBehaviorChanged(preflight, repoRoot, docsUpdated);
    const internalOnlyBehaviorChanged = shouldDefaultInternalOnlyBehaviorChanged(preflight, repoRoot, docsUpdated);
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push(`--behavior-changed ${behaviorChanged ? 'true' : 'false'}`);
        for (const docPath of docsUpdated) {
            parts.push(`--docs-updated ${quoteCommandValue(docPath)}`);
        }
        parts.push(`--changelog-updated ${changelogUpdated ? 'true' : 'false'}`);
    } else {
        parts.push('--decision "NO_DOC_UPDATES"');
        parts.push(`--behavior-changed ${internalOnlyBehaviorChanged ? 'true' : 'false'}`);
        parts.push('--changelog-updated false');
        if (internalOnlyBehaviorChanged) {
            parts.push('--project-memory-updated true');
        }
    }
    if (requiresSensitiveScopeDocAcknowledgement(preflight)) {
        parts.push('--sensitive-scope-reviewed true');
    }
    parts.push(docsUpdated.length > 0
        ? behaviorChanged
            ? '--rationale "Changelog and implementation files changed in the current preflight; recording documentation impact as behavior-changing by default. Adjust only if the changelog entry is not user-visible behavior."'
            : '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : internalOnlyBehaviorChanged
            ? '--rationale "Implementation files changed with no user-facing documentation paths; recording internal-only behavior evidence. Update task-scoped project memory before running if this command reports missing internal evidence."'
            : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function buildDocImpactCompatibilityHint(): string {
    return [
        'Compatible doc-impact choices:',
        'no user-facing docs -> --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false;',
        'docs only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated false plus --docs-updated for each user-facing doc;',
        'changelog/docs maintenance only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated true plus --docs-updated "CHANGELOG.md";',
        'changelog plus implementation scope -> next-step defaults to --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true;',
        'user-facing behavior changed -> --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true plus docs/changelog evidence;',
        'internal-only runtime behavior changed -> --decision "NO_DOC_UPDATES" --behavior-changed true plus --internal-changelog-updated true and/or --project-memory-updated true.'
    ].join(' ');
}

export function buildProjectMemoryNextStepSummary(
    evidence: ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>
): NextStepProjectMemorySummary {
    return {
        enabled: evidence.enabled,
        required: evidence.required,
        mode: evidence.mode,
        evidence_status: evidence.evidence_status,
        status: evidence.status,
        update_needed: evidence.update_needed,
        affected_memory_files: [...evidence.affected_memory_files],
        updated_memory_files: [...evidence.updated_memory_files],
        compact_status: evidence.compact_status,
        compact_refreshed: evidence.compact_refreshed,
        artifact_path: evidence.artifact_path,
        update_artifact_path: evidence.update_artifact_path,
        visible_summary_line: evidence.visible_summary_line
    };
}
