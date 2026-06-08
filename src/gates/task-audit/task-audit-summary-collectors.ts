import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, joinOrchestratorPath, resolvePathInsideRepo, toPosix } from '../shared/helpers';
import {
    computeOptionalSkillTaskTextSha256,
    buildCurrentCycleOptionalSkillActivationIndex,
    getActivatedCurrentCycleOptionalSkillReferenceLoads,
    getOptionalSkillSelectionArtifactViolations,
    isOptionalSkillSelectionPolicyConfigured,
    readOptionalSkillSelectionPolicyConfig,
    type OptionalSkillSelectionArtifactData,
    type OptionalSkillSelectionTimelineEvidence
} from '../../runtime/optional-skill-selection';
import type { DomainScopeFingerprints } from '../scope/domain-scope-fingerprints';

export { collectKnownRequiredReviewTypes, safeReadJson } from './task-audit-summary-review-common';
export {
    buildReviewAttemptSummary,
    readReviewVerdicts,
    type ReviewAttemptSummary,
    type ReviewAttemptTypeSummary
} from './task-audit-summary-review-attempts';
export {
    buildUnavailableRequiredReviewTrustSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    type FinalCloseoutReviewTrustSummary
} from './task-audit-summary-review-trust';
export {
    buildReviewIntegrityAttestation,
    type FinalCloseoutReviewIntegrityAttestation
} from './task-audit-summary-review-integrity';

export interface TaskQueueMetadata {
    area: string | null;
    title: string | null;
    profile: string | null;
    notes: string | null;
}

export interface GateOutcome {
    gate: string;
    status: 'PASS' | 'FAIL' | 'MISSING';
    event_type?: string;
    timestamp_utc?: string | null;
    artifact_path?: string | null;
}

export interface EvidenceArtifact {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

export interface BlockerEntry {
    gate: string;
    reason: string;
}

export interface FinalReportContract {
    status: 'READY' | 'NOT_READY';
    blocker: string | null;
    required_order: string[];
    implementation_summary_requirements: string[];
    commit_command_template: string;
    commit_command_suggestion: string;
    commit_question: string;
}

export interface FinalCloseoutArtifactPaths {
    json: string;
    markdown: string;
    final_user_report?: string;
}

export interface FinalCloseoutDocsSummary {
    decision: string | null;
    behavior_changed: boolean;
    changelog_updated: boolean;
    docs_updated: string[];
}

export interface FinalCloseoutChangeMetrics {
    preflight_changed_files_count: number;
    preflight_changed_lines_total: number;
    final_tracked_changed_files_count: number;
    final_tracked_changed_lines_total: number | null;
    final_tracked_changed_lines_source: 'workspace_snapshot' | 'unavailable';
    late_evidence_files: string[];
}

export interface FinalCloseoutImplementationSummary {
    requested_depth: number | null;
    effective_depth: number | null;
    path_mode: string | null;
    orchestrator_work?: boolean;
    workflow_config_work?: boolean;
    planned_changed_files?: string[];
    task_mode_scope_snapshot?: {
        orchestrator_work: boolean;
        workflow_config_work: boolean;
        planned_changed_files: string[];
        dirty_workspace_baseline_changed_files: string[];
        authorized_changed_files: string[];
    };
    review_verdicts: Record<string, string>;
    docs_updated: boolean;
    changed_files?: string[];
    changed_files_sha256?: string | null;
    scope_content_sha256?: string | null;
    scope_sha256?: string | null;
    domain_scope_fingerprints?: DomainScopeFingerprints | null;
    change_metrics?: FinalCloseoutChangeMetrics;
    changed_files_count: number;
    changed_lines_total: number;
    scope_category: string | null;
    active_profile: string | null;
}

export interface FinalCloseoutOptionalSkillsSummary {
    policy_mode: string | null;
    decision: string | null;
    selected_skill_ids: string[];
    used_skill_ids: string[];
    recommended_missing_pack_ids: string[];
    as_is_reason: string | null;
    visible_summary_line: string | null;
}

export interface ProfileReviewDecisionSummary {
    profile_name: string | null;
    scope_category: string | null;
    guardrails_active: boolean;
    lightening_eligible: boolean;
    safety_floors_applied: string[];
    decisions: Array<{
        review_type: string;
        effective_value: boolean;
        decision: string;
        reason?: string;
    }>;
}


export function resolveReviewsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
}

export function resolveEventsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
}

export function readTaskQueueMetadata(repoRoot: string, taskId: string): TaskQueueMetadata | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }

    const lines = fs.readFileSync(taskPath, 'utf8').split('\n');
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 9 || cells[0] !== taskId) {
            continue;
        }
        if (cells[0].toLowerCase() === 'id' || cells[0].startsWith('-') || cells[0].startsWith('=')) {
            continue;
        }
        return {
            area: cells[3] || null,
            title: cells[4] || null,
            profile: cells[7] || null,
            notes: cells[8] || null
        };
    }

    return null;
}

export function readDocImpactSummary(docImpact: Record<string, unknown> | null): FinalCloseoutDocsSummary {
    const docsUpdated = docImpact && Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    return {
        decision: docImpact && typeof docImpact.decision === 'string' ? docImpact.decision : null,
        behavior_changed: docImpact?.behavior_changed === true,
        changelog_updated: docImpact?.changelog_updated === true,
        docs_updated: docsUpdated
    };
}

export function readOptionalSkillsSummary(
    bundleRoot: string,
    preflightPath: string,
    preflightSha256: string | null,
    currentTaskText: string | null,
    invalidateOnMissingTaskRow: boolean,
    optionalSkillsPath: string,
    optionalSkills: Record<string, unknown> | null,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): FinalCloseoutOptionalSkillsSummary | null {
    if (!optionalSkills) {
        if (isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
            const policyMode = readOptionalSkillSelectionPolicyConfig(bundleRoot).mode;
            if (policyMode === 'off') {
                return {
                    policy_mode: policyMode,
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'policy_off',
                    visible_summary_line: 'Optional skills: as_is (reason: policy_off)'
                };
            }
        }
        return null;
    }
    const artifactPolicyMode = String(optionalSkills.policy_mode || '').trim() || null;
    if (!preflightSha256) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'invalidated',
            selected_skill_ids: [],
            used_skill_ids: [],
            recommended_missing_pack_ids: [],
            as_is_reason: 'artifact_drift',
            visible_summary_line: 'Optional skills: unavailable (reason: artifact_drift)'
        };
    }
    const artifact = {
        artifactPath: optionalSkillsPath,
        payload: optionalSkills
    } as unknown as OptionalSkillSelectionArtifactData;
    const validationOptions: Parameters<typeof getOptionalSkillSelectionArtifactViolations>[2] = {
        requireMaterializedArtifact: true,
        expectedPreflightPath: preflightPath,
        expectedPreflightSha256: preflightSha256,
        validateAgainstCurrentHeadlines: false,
        validateAgainstCurrentInventory: false
    };
    if (currentTaskText != null) {
        validationOptions.expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(String(currentTaskText || ''));
    } else if (invalidateOnMissingTaskRow) {
        validationOptions.expectedTaskTextSha256 = null;
    }
    const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, validationOptions);
    if (violations.length > 0) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'invalidated',
            selected_skill_ids: [],
            used_skill_ids: [],
            recommended_missing_pack_ids: [],
            as_is_reason: 'artifact_drift',
            visible_summary_line: 'Optional skills: unavailable (reason: artifact_drift)'
        };
    }
    const selectedSkillIds = Array.isArray(optionalSkills.selected_installed_skills)
        ? optionalSkills.selected_installed_skills
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }
                return String((entry as Record<string, unknown>).id || '').trim() || null;
            })
            .filter((entry): entry is string => !!entry)
        : [];
    const recommendedMissingPackIds = Array.isArray(optionalSkills.recommended_missing_packs)
        ? optionalSkills.recommended_missing_packs
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }
                return String((entry as Record<string, unknown>).id || '').trim() || null;
            })
            .filter((entry): entry is string => !!entry)
        : [];
    const visibleSummaryLine = String(optionalSkills.visible_summary_line || '').trim() || null;
    if (timelineEvidence.invalidJson) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'unavailable',
            selected_skill_ids: selectedSkillIds,
            used_skill_ids: [],
            recommended_missing_pack_ids: recommendedMissingPackIds,
            as_is_reason: 'task_events_integrity',
            visible_summary_line: 'Optional skills: unavailable (reason: task_events_integrity)'
        };
    }
    const currentCycleReferenceLoads = getActivatedCurrentCycleOptionalSkillReferenceLoads(artifact.payload, timelineEvidence);
    const currentCycleActivationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, timelineEvidence);
    const usedSkillIds = selectedSkillIds.filter((entry) => (
        currentCycleActivationIndex.has(entry)
        || currentCycleReferenceLoads.some((load) => load.skillId === entry)
    ));
    let usageSummaryLine = visibleSummaryLine;
    const reasonMatch = visibleSummaryLine?.match(/\(reason:\s*([^)]+)\)\s*$/i);
    const reasonSuffix = reasonMatch?.[1]?.trim();
    if (selectedSkillIds.length > 0 && usedSkillIds.length === 0) {
        usageSummaryLine = reasonSuffix
            ? `Optional skills: none_used (selected: ${selectedSkillIds.join(', ')}, reason: ${reasonSuffix})`
            : `Optional skills: none_used (selected: ${selectedSkillIds.join(', ')})`;
    } else if (usedSkillIds.length > 0 && usedSkillIds.length !== selectedSkillIds.length) {
        usageSummaryLine = reasonSuffix
            ? `Optional skills: ${usedSkillIds.join(', ')} (reason: ${reasonSuffix})`
            : `Optional skills: ${usedSkillIds.join(', ')}`;
    }
    return {
        policy_mode: artifactPolicyMode,
        decision: String(optionalSkills.decision || '').trim() || null,
        selected_skill_ids: selectedSkillIds,
        used_skill_ids: usedSkillIds,
        recommended_missing_pack_ids: recommendedMissingPackIds,
        as_is_reason: String(optionalSkills.as_is_reason || '').trim() || null,
        visible_summary_line: usageSummaryLine
    };
}

export function updateEvidenceArtifactState(
    evidence: EvidenceArtifact[],
    kind: string,
    artifactPath: string,
    exists: boolean
): void {
    const normalizedPath = toPosix(path.resolve(artifactPath));
    const entry = evidence.find((candidate) => candidate.kind === kind);
    const sha256 = exists ? fileSha256(artifactPath) : null;
    if (entry) {
        entry.path = normalizedPath;
        entry.exists = exists;
        entry.sha256 = sha256;
        return;
    }
    evidence.push({
        kind,
        path: normalizedPath,
        exists,
        sha256
    });
}

export function parseOptionalNumber(value: unknown): number | null {
    if (value == null || value === '') {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
