import type { FinalCloseoutArtifact, TaskAuditSummaryResult } from './task-audit-summary';
import { toPosix } from './helpers';
import type { ReviewAttemptSummary, TaskQueueMetadata } from './task-audit-summary-collectors';
import {
    buildAgentReportBlock,
    getAgentReportMessages
} from '../cli/commands/cli-format-output';
import { getNodeGateCommandPrefix } from '../materialization/command-constants';
import { buildTaskQueueStatusContract } from '../core/task-queue-status-contract';

type ReviewIntegrityAttestation = NonNullable<FinalCloseoutArtifact['review_integrity_attestation']>;

function buildFallbackReviewIntegrityAttestation(closeout: FinalCloseoutArtifact): ReviewIntegrityAttestation {
    const reviewVerdictCount = Object.keys(closeout.implementation_summary.review_verdicts || {}).length;
    const reason = 'Legacy final closeout artifact lacks the mandatory review integrity attestation; completion is not review-attested.';
    return {
        schema_version: 1, enforcement_mode: 'BLOCKING', status: 'DEGRADED_OR_UNVERIFIABLE', required_review_count: reviewVerdictCount,
        required_review_types: Object.keys(closeout.implementation_summary.review_verdicts || {}).sort(),
        independent_review_completed: false, completion_review_attested: false, completion_review_attestation_not_required: false, completion_allowed: false,
        fake_or_fallback_artifacts_observed: false, same_agent_fallback_observed: false, fallback_artifacts_observed: false,
        legacy_local_review_observed: true, missing_or_unverifiable_artifacts_observed: true, fabricated_artifacts_observed: false,
        observed_issues: ['legacy final closeout artifact lacks review integrity attestation'], reason,
        visible_summary_line:
            'Review integrity: DEGRADED_OR_UNVERIFIABLE; independent_review_completed=no; ' +
            'completion_review_attested=no; completion_allowed=no; fake/fallback/unverifiable artifacts observed=yes; enforcement=blocking.',
        final_report_lines: [
            'Review integrity: DEGRADED_OR_UNVERIFIABLE.',
            'Review integrity enforcement: blocking; final closeout is blocked until mandatory review trust is independently attested.',
            'Independent review completed: no.',
            'Completion review-attested: no.',
            'Fake/fallback artifacts observed: no.',
            'Same-agent fallback observed: no.',
            'Fallback artifacts observed: no.',
            'Legacy local review observed: yes.',
            'Missing/unverifiable artifacts observed: yes.',
            'Fabricated artifacts observed: no.',
            `Completion allowed: no. Reason: ${reason}`
        ]
    };
}

function getReviewIntegrityAttestation(closeout: FinalCloseoutArtifact): ReviewIntegrityAttestation {
    return closeout.review_integrity_attestation || buildFallbackReviewIntegrityAttestation(closeout);
}

function shouldRenderReviewTrustSummary(
    closeout: FinalCloseoutArtifact,
    reviewIntegrityAttestation: ReviewIntegrityAttestation
): boolean {
    if (!closeout.review_trust) {
        return false;
    }
    if (
        reviewIntegrityAttestation.completion_review_attested ||
        reviewIntegrityAttestation.completion_review_attestation_not_required ||
        reviewIntegrityAttestation.status === 'NO_REVIEW_REQUIRED'
    ) {
        return true;
    }
    return closeout.review_trust.independent_review_attested !== true;
}

function normalizeCommitToken(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function normalizeCommitSubject(value: string): string {
    const normalized = String(value || '')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.]+$/g, '')
        .replace(/"/g, '\'');
    if (!normalized) {
        return '<summary>';
    }
    return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function inferCommitType(taskMetadata: TaskQueueMetadata | null): 'feat' | 'fix' {
    const text = `${taskMetadata?.area || ''} ${taskMetadata?.title || ''}`.toLowerCase();
    const featureKeywords = ['add', 'introduce', 'support', 'enable', 'create', 'implement', 'allow', 'reuse', 'automate', 'generate', 'install'];
    return featureKeywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(text)) ? 'feat' : 'fix';
}

function inferCommitScope(changedFiles: string[], taskMetadata: TaskQueueMetadata | null): string {
    const scopeMatchers: Array<{ scope: string; patterns: RegExp[] }> = [
        {
            scope: 'orchestration',
            patterns: [
                /^src\/gates\//,
                /^src\/cli\/commands\/gate-/,
                /^template\/docs\/agent-rules\//,
                /^template\/skills\/orchestration\//,
                /^tests\/node\/gates\/task-audit-summary\.test\.ts$/,
                /^tests\/node\/validators\/verify\.test\.ts$/
            ]
        },
        { scope: 'runtime', patterns: [/^src\/gate-runtime\//] },
        { scope: 'validators', patterns: [/^src\/validators\//] },
        { scope: 'materialization', patterns: [/^src\/materialization\//] },
        { scope: 'setup', patterns: [/^src\/cli\/commands\/setup\.ts$/, /^src\/lifecycle\/setup/i] },
        { scope: 'update', patterns: [/^src\/lifecycle\/update\.ts$/, /^src\/lifecycle\/check-update/i] }
    ];
    const scopeScores = new Map<string, number>();
    const normalizedChangedFiles = [...new Set(changedFiles.map((changedFile) => toPosix(String(changedFile || ''))))]
        .sort((left, right) => left.localeCompare(right));
    for (const normalizedPath of normalizedChangedFiles) {
        for (const matcher of scopeMatchers) {
            if (matcher.patterns.some((pattern) => pattern.test(normalizedPath))) {
                scopeScores.set(matcher.scope, (scopeScores.get(matcher.scope) || 0) + 1);
            }
        }
    }

    let bestScope: string | null = null;
    let bestScore = -1;
    for (const [scope, score] of [...scopeScores.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        if (score > bestScore || (score === bestScore && bestScope != null && scope.localeCompare(bestScope) < 0)) {
            bestScope = scope;
            bestScore = score;
        }
    }
    if (bestScope) {
        return bestScope;
    }

    const rawArea = String(taskMetadata?.area || '').trim();
    const [areaPrefix = ''] = rawArea.split('/');
    const normalizedAreaPrefix = normalizeCommitToken(areaPrefix);
    if (normalizedAreaPrefix && !['ux', 'reliability', 'performance', 'security', 'docs', 'feature', 'feat'].includes(normalizedAreaPrefix)) {
        return normalizedAreaPrefix;
    }

    return 'orchestration';
}

function inferCommitSubject(taskMetadata: TaskQueueMetadata | null): string {
    const rawArea = String(taskMetadata?.area || '').trim();
    const areaSuffix = rawArea.includes('/') ? rawArea.split('/').pop() || '' : rawArea;
    const normalizedAreaSubject = normalizeCommitSubject(areaSuffix);
    if (normalizedAreaSubject !== '<summary>' && normalizedAreaSubject.length >= 6) {
        return normalizedAreaSubject;
    }

    return normalizeCommitSubject(String(taskMetadata?.title || ''));
}

export function buildCommitCommandSuggestion(
    changedFiles: string[],
    taskMetadata: TaskQueueMetadata | null,
    commitGuardEnabled: boolean
): { template: string; suggestion: string } {
    const template = commitGuardEnabled
        ? `${getNodeGateCommandPrefix()} human-commit --message "<type>(<scope>): <summary>"`
        : 'git commit -m "<type>(<scope>): <summary>"';
    const subject = inferCommitSubject(taskMetadata);
    if (subject === '<summary>') {
        return { template, suggestion: template };
    }

    const type = inferCommitType(taskMetadata);
    const scope = inferCommitScope(changedFiles, taskMetadata);
    const message = `${type}(${scope}): ${subject}`;
    return {
        template,
        suggestion: commitGuardEnabled
            ? `${getNodeGateCommandPrefix()} human-commit --message "${message}"`
            : `git commit -m "${message}"`
    };
}

function buildLocalizedCloseoutReviewMode(
    closeout: FinalCloseoutArtifact,
    reviewIntegrityAttestation: ReviewIntegrityAttestation
): string {
    const reportMessages = getAgentReportMessages();
    let trustPrefix: string;
    if (
        reviewIntegrityAttestation.status === 'INDEPENDENT_REVIEW_ATTESTED' &&
        reviewIntegrityAttestation.completion_review_attested
    ) {
        trustPrefix = reportMessages.summaries.independentReviewAttested;
    } else if (
        reviewIntegrityAttestation.status === 'NO_REVIEW_REQUIRED' ||
        reviewIntegrityAttestation.completion_review_attestation_not_required
    ) {
        trustPrefix = reportMessages.summaries.noRequiredReview;
    } else {
        trustPrefix = `review integrity=${reviewIntegrityAttestation.status}`;
    }
    const verdicts = Object.entries(closeout.implementation_summary.review_verdicts)
        .map(([reviewType, verdict]) => `${reviewType}=${verdict}`);
    if (verdicts.length === 0) {
        return trustPrefix;
    }
    return `${trustPrefix}; ${reportMessages.summaries.verdicts}: ${verdicts.join(', ')}`;
}

function buildLocalizedOptionalSkillsSummary(
    closeout: FinalCloseoutArtifact
): string | null {
    const reportMessages = getAgentReportMessages();
    const summary = closeout.optional_skills;
    if (!summary) {
        return null;
    }
    const visibleSummaryLine = String(summary.visible_summary_line || '').trim();
    const reasonMatch = visibleSummaryLine.match(/(?:\(|,\s*)reason:\s*([^)]+)\)\s*$/i);
    const reasonValue = reasonMatch?.[1]?.trim() || null;
    const reasonSuffix = reasonValue
        ? ` (${reportMessages.summaries.reason}: ${reasonValue})`
        : '';
    if (summary.decision === 'selected_installed_skills' && summary.selected_skill_ids.length > 0) {
        if (summary.used_skill_ids.length === 0) {
            const selectedDetails = `${reportMessages.summaries.selected}: ${summary.selected_skill_ids.join(', ')}`;
            return `${reportMessages.summaries.noneUsed} (${selectedDetails}${reasonValue ? `, ${reportMessages.summaries.reason}: ${reasonValue}` : ''})`;
        }
        if (summary.used_skill_ids.length !== summary.selected_skill_ids.length) {
            return `${summary.used_skill_ids.join(', ')}${reasonSuffix}`;
        }
        return `${reportMessages.summaries.selected}: ${summary.selected_skill_ids.join(', ')}`;
    }
    if (summary.decision === 'recommended_missing_packs' && summary.recommended_missing_pack_ids.length > 0) {
        return `${reportMessages.summaries.recommendedPacks}: ${summary.recommended_missing_pack_ids.join(', ')}`;
    }
    if (summary.decision === 'as_is') {
        return `${reportMessages.summaries.noAdditionalSkills}${summary.as_is_reason ? ` (${summary.as_is_reason})` : ''}`;
    }
    if (summary.decision === 'unavailable' || summary.decision === 'invalidated') {
        return `${reportMessages.summaries.unavailable}${reasonSuffix}`;
    }
    if (visibleSummaryLine) {
        return visibleSummaryLine.replace(/^Optional skills:\s*/i, '');
    }
    return summary.visible_summary_line;
}

function getReviewAttemptSummaryLine(summary: ReviewAttemptSummary | null | undefined): string | null {
    const visibleSummaryLine = String(summary?.visible_summary_line || '').trim();
    return visibleSummaryLine || null;
}

function formatTaskModeAuthorizationSummary(
    implementationSummary: FinalCloseoutArtifact['implementation_summary']
): string {
    const plannedChangedFiles = Array.isArray(implementationSummary.planned_changed_files)
        ? implementationSummary.planned_changed_files
        : [];
    const base =
        `orchestrator_work=${implementationSummary.orchestrator_work === true}; ` +
        `workflow_config_work=${implementationSummary.workflow_config_work === true}`;
    if (plannedChangedFiles.length === 0) {
        return base;
    }
    return `${base}; planned_changed_files=${plannedChangedFiles.join(', ')}`;
}

export function formatFinalCloseoutMarkdown(closeout: FinalCloseoutArtifact): string {
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(closeout);
    const profileText = closeout.implementation_summary.active_profile
        ? `profile=${closeout.implementation_summary.active_profile}`
        : 'profile=unknown';
    const pathModeText = closeout.implementation_summary.path_mode || 'unknown';
    const reviewVerdicts = Object.entries(closeout.implementation_summary.review_verdicts)
        .map(([reviewType, verdict]) => `\`${reviewType}: ${verdict}\``);
    const reviewVerdictText = reviewVerdicts.length > 0 ? reviewVerdicts.join(', ') : '`none required`';
    const docsUpdatedText = closeout.implementation_summary.docs_updated ? '`yes`' : '`no`';

    const lines: string[] = ['## Review Integrity Attestation'];
    for (const entry of reviewIntegrityAttestation.final_report_lines) {
        lines.push(`- ${entry}`);
    }
    if (reviewIntegrityAttestation.observed_issues.length > 0) {
        lines.push('- Observed review evidence issues:');
        for (const issue of reviewIntegrityAttestation.observed_issues) {
            lines.push(`  - ${issue}`);
        }
    }

    lines.push('');
    lines.push(
        `Task \`${closeout.task_id}\` completed in \`${profileText}\`, \`path mode=${pathModeText}\`. ` +
        `Review verdicts: ${reviewVerdictText}. Docs updated: ${docsUpdatedText}.`
    );
    lines.push(`Task-mode authorization: ${formatTaskModeAuthorizationSummary(closeout.implementation_summary)}.`);

    if (closeout.optional_skills?.visible_summary_line) {
        lines.push(closeout.optional_skills.visible_summary_line);
    }

    if (shouldRenderReviewTrustSummary(closeout, reviewIntegrityAttestation) && closeout.review_trust?.visible_summary_line) {
        lines.push(closeout.review_trust.visible_summary_line);
    }

    if (shouldRenderReviewTrustSummary(closeout, reviewIntegrityAttestation) && closeout.review_trust?.policy_summary_line) {
        lines.push(closeout.review_trust.policy_summary_line);
    }

    const reviewAttemptSummaryLine = getReviewAttemptSummaryLine(closeout.review_attempt_summary);
    if (reviewAttemptSummaryLine) {
        lines.push(reviewAttemptSummaryLine);
    }

    if (closeout.workflow?.visible_summary_line) {
        lines.push(closeout.workflow.visible_summary_line);
    }

    if (closeout.workflow?.review_execution_policy_summary_line) {
        lines.push(closeout.workflow.review_execution_policy_summary_line);
    }

    if (closeout.project_memory?.visible_summary_line) {
        lines.push(closeout.project_memory.visible_summary_line);
    }

    if (closeout.token_economy?.visible_summary_line) {
        lines.push(closeout.token_economy.visible_summary_line);
    }

    lines.push((closeout.task_queue_status_contract || buildTaskQueueStatusContract(closeout.task_id)).visible_summary_line);
    lines.push('');
    lines.push(buildAgentReportBlock({
        context: 'task_closeout',
        assistantLanguage: closeout.agent_report?.assistant_language || null,
        assistantLanguageConfirmed: closeout.agent_report?.assistant_language_confirmed ?? null,
        profileSummary: closeout.implementation_summary.active_profile,
        reviewModeSummary: buildLocalizedCloseoutReviewMode(closeout, reviewIntegrityAttestation),
        optionalSkillsSummary: buildLocalizedOptionalSkillsSummary(closeout),
        mandatoryFullSuiteEnabled: closeout.workflow?.mandatory_full_suite_enabled ?? null,
        nextTaskPrompt: closeout.agent_report?.next_task_command || null,
        latestUpdateNotice: closeout.agent_report?.latest_update_notice || null
    }));

    lines.push('');
    lines.push('Suggested commit command:');
    lines.push('```bash');
    lines.push(closeout.commit_command_suggestion);
    lines.push('```');
    lines.push('');
    lines.push(closeout.commit_question);

    return lines.join('\n');
}

export function formatTaskAuditSummaryText(summary: TaskAuditSummaryResult): string {
    const lines: string[] = [];

    lines.push(`Task: ${summary.task_id}`);
    lines.push(`Status: ${summary.status}`);
    lines.push(`Events: ${summary.events_count}`);
    lines.push(`Integrity: ${summary.integrity_status}`);
    if (summary.first_event_utc) lines.push(`FirstEvent: ${summary.first_event_utc}`);
    if (summary.last_event_utc) lines.push(`LastEvent: ${summary.last_event_utc}`);

    lines.push('');
    lines.push('Gates:');
    for (const gate of summary.gates) {
        const marker = gate.status === 'PASS' ? '[+]' : gate.status === 'FAIL' ? '[X]' : '[ ]';
        const ts = gate.timestamp_utc ? ` (${gate.timestamp_utc})` : '';
        lines.push(`  ${marker} ${gate.gate}${ts}`);
    }

    lines.push('');
    lines.push(`ChangedFiles: ${summary.changed_files_count} (${summary.changed_lines_total} lines)`);
    for (const file of summary.changed_files) {
        lines.push(`  - ${file}`);
    }

    const activeReviews = Object.entries(summary.required_reviews)
        .filter(([, v]) => v)
        .map(([k]) => k);
    if (activeReviews.length > 0) {
        lines.push('');
        lines.push(`RequiredReviews: ${activeReviews.join(', ')}`);
    }

    if (summary.scope_category) {
        lines.push(`ScopeCategory: ${summary.scope_category}`);
    }

    lines.push(`TaskModeAuthorization: ${formatTaskModeAuthorizationSummary(summary.final_closeout.implementation_summary)}`);

    const reviewAttemptSummaryLine = getReviewAttemptSummaryLine(summary.review_attempt_summary);
    if (reviewAttemptSummaryLine) {
        lines.push('');
        lines.push(reviewAttemptSummaryLine);
    }

    if (summary.profile_review_decisions) {
        const prd = summary.profile_review_decisions;
        lines.push('');
        lines.push('ProfileReviewDecisions:');
        if (prd.profile_name) lines.push(`  Profile: ${prd.profile_name}`);
        if (prd.scope_category) lines.push(`  ScopeCategory: ${prd.scope_category}`);
        lines.push(`  GuardrailsActive: ${prd.guardrails_active}`);
        lines.push(`  LighteningEligible: ${prd.lightening_eligible}`);
        if (prd.decisions.length > 0) {
            for (const d of prd.decisions) {
                const marker = d.decision === 'safety_floor_enforced' ? '[!]'
                    : d.decision === 'lightened_by_profile' ? '[-]'
                        : '[=]';
                lines.push(`  ${marker} ${d.review_type}: ${d.effective_value} (${d.decision})`);
            }
        }
        if (prd.safety_floors_applied.length > 0) {
            lines.push('  SafetyFloors:');
            for (const f of prd.safety_floors_applied) {
                lines.push(`    - ${f}`);
            }
        }
    }

    const presentEvidence = summary.evidence.filter((e) => e.exists);
    const missingEvidence = summary.evidence.filter((e) => !e.exists);
    lines.push('');
    lines.push(`Evidence (${presentEvidence.length} present, ${missingEvidence.length} absent):`);
    for (const e of presentEvidence) {
        lines.push(`  [+] ${e.kind}: ${e.path}`);
    }
    for (const e of missingEvidence) {
        lines.push(`  [ ] ${e.kind}: ${e.path}`);
    }

    if (summary.blockers.length > 0) {
        lines.push('');
        lines.push('Blockers:');
        for (const b of summary.blockers) {
            lines.push(`  [!] ${b.gate}: ${b.reason}`);
        }
    }

    if (summary.point_in_time_snapshot.status !== 'STABLE') {
        lines.push('');
        lines.push(`PointInTimeSnapshot: ${summary.point_in_time_snapshot.status}`);
        if (summary.point_in_time_snapshot.message) {
            lines.push(`  Reason: ${summary.point_in_time_snapshot.message}`);
        }
        if (summary.point_in_time_snapshot.recommended_action) {
            lines.push(`  RecommendedAction: ${summary.point_in_time_snapshot.recommended_action}`);
        }
        if (summary.point_in_time_snapshot.lock_path) {
            lines.push(`  LockPath: ${summary.point_in_time_snapshot.lock_path}`);
        }
        if (summary.point_in_time_snapshot.owner_pid !== undefined) {
            lines.push(`  OwnerPid: ${summary.point_in_time_snapshot.owner_pid === null ? 'unknown' : summary.point_in_time_snapshot.owner_pid}`);
        }
        if (summary.point_in_time_snapshot.owner_hostname !== undefined) {
            lines.push(`  OwnerHost: ${summary.point_in_time_snapshot.owner_hostname || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.owner_created_at_utc !== undefined) {
            lines.push(`  OwnerCreatedAtUtc: ${summary.point_in_time_snapshot.owner_created_at_utc || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.owner_alive !== undefined) {
            lines.push(`  OwnerAlive: ${summary.point_in_time_snapshot.owner_alive === null ? 'unknown' : summary.point_in_time_snapshot.owner_alive}`);
        }
        if (summary.point_in_time_snapshot.owner_metadata_status !== undefined) {
            lines.push(`  OwnerMetadataStatus: ${summary.point_in_time_snapshot.owner_metadata_status || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.stale_reason !== undefined) {
            lines.push(`  StaleReason: ${summary.point_in_time_snapshot.stale_reason || 'none'}`);
        }
        if (summary.point_in_time_snapshot.subsystem_scope_note) {
            lines.push(`  Scope: ${summary.point_in_time_snapshot.subsystem_scope_note}`);
        }
        if (summary.point_in_time_snapshot.acquisition_policy) {
            lines.push(
                `  AcquisitionPolicy: timeout=${summary.point_in_time_snapshot.acquisition_policy.timeout_ms}ms ` +
                `retry=${summary.point_in_time_snapshot.acquisition_policy.retry_ms}ms ` +
                `stale_after=${summary.point_in_time_snapshot.acquisition_policy.stale_after_ms}ms`
            );
        }
    }

    lines.push('');
    lines.push(`FinalReportContract: ${summary.final_report_contract.status}`);
    if (summary.final_report_contract.blocker) {
        lines.push(`  Reason: ${summary.final_report_contract.blocker}`);
    }
    lines.push(`FinalCloseout: ${summary.final_closeout.status} (${summary.final_closeout.artifact_state})`);
    lines.push(`  JsonArtifact: ${summary.final_closeout.artifact_paths.json}`);
    lines.push(`  MarkdownArtifact: ${summary.final_closeout.artifact_paths.markdown}`);
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(summary.final_closeout);
    if (summary.final_closeout.optional_skills?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.optional_skills.visible_summary_line}`);
    }
    if (shouldRenderReviewTrustSummary(summary.final_closeout, reviewIntegrityAttestation) && summary.final_closeout.review_trust?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.review_trust.visible_summary_line}`);
    }
    if (shouldRenderReviewTrustSummary(summary.final_closeout, reviewIntegrityAttestation) && summary.final_closeout.review_trust?.policy_summary_line) {
        lines.push(`  ${summary.final_closeout.review_trust.policy_summary_line}`);
    }
    if (summary.final_closeout.review_attempt_summary?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.review_attempt_summary.visible_summary_line}`);
    }
    lines.push(`  ${reviewIntegrityAttestation.visible_summary_line}`);
    if (reviewIntegrityAttestation.observed_issues.length > 0) {
        lines.push('  ReviewIntegrityIssues:');
        for (const issue of reviewIntegrityAttestation.observed_issues) {
            lines.push(`    - ${issue}`);
        }
    }
    if (summary.final_closeout.workflow?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.workflow.visible_summary_line}`);
    }
    if (summary.final_closeout.workflow?.review_execution_policy_summary_line) {
        lines.push(`  ${summary.final_closeout.workflow.review_execution_policy_summary_line}`);
    }
    if (summary.final_closeout.project_memory?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.project_memory.visible_summary_line}`);
    }
    if (summary.final_closeout.token_economy?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.token_economy.visible_summary_line}`);
    }
    lines.push(`  ${(summary.final_closeout.task_queue_status_contract || buildTaskQueueStatusContract(summary.task_id)).visible_summary_line}`);
    lines.push('FinalReportOrder:');
    for (const [index, entry] of summary.final_report_contract.required_order.entries()) {
        const suffix = entry === 'implementation summary' ? ` (include ${summary.final_report_contract.implementation_summary_requirements.join(', ')})` : '';
        lines.push(`  ${index + 1}. ${entry}${suffix}`);
    }

    return lines.join('\n');
}
