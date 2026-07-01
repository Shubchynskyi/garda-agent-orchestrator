import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../core/project-memory-rollout';
import {
    formatProviderComplianceSummary
} from '../provider-compliance';
import {
    formatToxinSummaryLines
} from '../../runtime/toxin-metrics';
import type { StatusSnapshot } from './status-types';

function buildHeadlineText(snapshot: StatusSnapshot): string {
    if (snapshot.readyForTasks) {
        return 'Workspace ready';
    }
    if (snapshot.primaryInitializationComplete) {
        return 'Agent setup required';
    }
    if (snapshot.bundlePresent) {
        return 'Primary setup required';
    }
    return 'Not installed';
}

function buildBadge(enabled: boolean, options?: { warning?: boolean }): string {
    const warning = options?.warning || false;
    if (enabled) return '[x]';
    if (warning) return '[~]';
    return '[ ]';
}

function buildSeverityBadge(severity: 'pass' | 'warn' | 'fail'): string {
    switch (severity) {
        case 'pass':
            return '[x]';
        case 'warn':
            return '[~]';
        default:
            return '[ ]';
    }
}

function appendParityLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.parityResult.isSourceCheckout) {
        return;
    }

    lines.push(`  ${buildBadge(!snapshot.parityResult.isStale, { warning: snapshot.parityResult.isStale })} Source parity (Self-hosted)`);
    if (!snapshot.parityResult.isStale) {
        return;
    }
    for (const violation of snapshot.parityResult.violations) {
        lines.push(`    Violation: ${violation}`);
    }
}

function appendProviderComplianceLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.providerComplianceResult) {
        return;
    }

    lines.push(`  ${buildBadge(snapshot.providerComplianceResult.passed)} Provider control compliance`);
    if (snapshot.providerComplianceResult.passed) {
        return;
    }

    const complianceLines = formatProviderComplianceSummary(snapshot.providerComplianceResult);
    for (const line of complianceLines.slice(1)) {
        lines.push(`  ${line}`);
    }
}

function appendProtectedManifestLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.protectedManifestEvidence) {
        return;
    }

    const manifestStatus = snapshot.protectedManifestEvidence.status;
    const manifestAssessment = snapshot.protectedManifestAssessment;
    const manifestSeverity = manifestAssessment?.severity
        || (manifestStatus === 'MATCH' || manifestStatus === 'MISSING' ? 'pass' : 'fail');
    lines.push(`  ${buildSeverityBadge(manifestSeverity)} Protected manifest (${manifestStatus})`);
    lines.push('    Role: trusted protected control-plane baseline for lifecycle drift checks.');

    if (manifestAssessment?.code === 'INFO_SOURCE_CHECKOUT') {
        lines.push('    Assessment: INFO_SOURCE_CHECKOUT');
        lines.push('    Info: self-hosted source-checkout drift is informational while protected source and generated bundle files evolve together.');
        lines.push('    Impact: status keeps the workspace ready, while task-start gates still enforce dirty-baseline and manifest guardrails for true pre-start drift.');
        lines.push('    Optional: Run setup/update/reinit after intentional control-plane changes settle and you want to refresh the trusted baseline.');
        return;
    }

    if (manifestAssessment?.code === 'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT') {
        lines.push('    Assessment: INFO_SOURCE_CHECKOUT_INHERITED_DRIFT');
        lines.push('    Info: self-hosted source-checkout drift is inherited from prior committed control-plane work, not current dirty task scope.');
        lines.push('    Impact: task-start gates should not force --orchestrator-work solely for this inherited clean-worktree drift.');
        lines.push('    Optional: Run repair protected-manifest after operator verification to refresh the trusted baseline.');
        return;
    }

    if (manifestAssessment?.code === 'INFO_TASK_CONTEXT_ALLOWED_DRIFT') {
        lines.push('    Assessment: INFO_TASK_CONTEXT_ALLOWED_DRIFT');
        lines.push('    Info: current task context already explains this protected-manifest drift.');
        return;
    }

    if (manifestStatus === 'DRIFT') {
        const driftCount = snapshot.protectedManifestEvidence.changed_files.length;
        lines.push(`    Drift: ${driftCount} file(s) changed since last trusted snapshot`);
        for (const changedFile of snapshot.protectedManifestEvidence.changed_files.slice(0, 5)) {
            lines.push(`    - ${changedFile}`);
        }
        if (driftCount > 5) {
            lines.push(`    ... and ${driftCount - 5} more`);
        }
        lines.push('    Fix: Run setup/update/reinit to refresh the trusted lifecycle baseline, or restart with --orchestrator-work if the task intentionally changes orchestrator control-plane files.');
        return;
    }

    if (manifestStatus === 'INVALID') {
        lines.push('    Warning: trusted manifest is malformed; re-run setup/update/reinit');
        lines.push('    Fix: Run setup/update/reinit before ordinary tasks, or restart with --orchestrator-work if this task intentionally changes orchestrator control-plane files.');
    }
}

function buildPendingCheckpointLine(snapshot: StatusSnapshot): string | null {
    switch (snapshot.agentInitializationPendingReason) {
        case 'AGENT_HANDOFF_REQUIRED':
            return '  Next stage: Launch your agent with AGENT_INIT_PROMPT.md';
        case 'LANGUAGE_CONFIRMATION_PENDING':
            return '  Pending checkpoint: Confirm assistant language during AGENT_INIT_PROMPT flow';
        case 'ACTIVE_AGENT_FILES_PENDING':
            return '  Pending checkpoint: Confirm active agent files during AGENT_INIT_PROMPT flow';
        case 'AGENT_STATE_STALE':
            return '  Pending checkpoint: Agent-init state no longer matches current init answers; rerun AGENT_INIT_PROMPT flow';
        case 'PROJECT_RULES_PENDING':
            return '  Pending checkpoint: Update project-specific live rules before finalizing agent init';
        case 'SKILLS_PROMPT_PENDING':
            return '  Pending checkpoint: Ask the optional specialist-skills yes/no question before finalizing agent init; user decline is allowed';
        case 'ORDINARY_DOC_PATHS_PENDING':
            return '  Pending checkpoint: Confirm ordinary document paths during AGENT_INIT_PROMPT flow';
        case 'PROJECT_MEMORY_PENDING':
            return '  Pending checkpoint: Initialize or refresh Garda project memory during AGENT_INIT_PROMPT flow';
        case 'PROJECT_COMMANDS_PENDING':
            return `  Missing project commands: ${snapshot.missingProjectCommands.length}`;
        case 'VALIDATION_PENDING':
            return '  Pending checkpoint: Run agent-init validation to get verify + manifest PASSED';
        case 'AGENT_STATE_INVALID':
            return '  Pending checkpoint: Repair invalid agent-init state file';
        default:
            return null;
    }
}

function appendTimelineLines(lines: string[], snapshot: StatusSnapshot): void {
    if (snapshot.timelineTaskCount === 0 && snapshot.timelineWarnings.length === 0) {
        return;
    }

    lines.push(`TaskTimelines: ${snapshot.timelineHealthy}/${snapshot.timelineTaskCount} complete`);
    lines.push('  Canonical task timelines: garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl');
    lines.push('  Derived indexes: garda-agent-orchestrator/runtime/task-events/all-tasks.jsonl, garda-agent-orchestrator/runtime/task-events/.timeline-summary.json');
    for (const warning of snapshot.timelineWarnings) {
        lines.push(`  Warning: ${warning}`);
    }
}

function appendToxinLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.toxinMetricsSummary) {
        return;
    }

    lines.push('');
    lines.push('Toxin Metrics');
    for (const line of formatToxinSummaryLines(snapshot.toxinMetricsSummary)) {
        lines.push(`  ${line}`);
    }
}

function appendCommandsLines(lines: string[], snapshot: StatusSnapshot): void {
    if (snapshot.agentInitializationPendingReason !== 'PROJECT_COMMANDS_PENDING') {
        return;
    }
    lines.push(`CommandsRule: ${snapshot.commandsRulePath}`);
    lines.push('CommandsStatus: PENDING_AGENT_CONTEXT');
}

function appendScopeBudgetLines(lines: string[], snapshot: StatusSnapshot): void {
    const scopeBudget = snapshot.scopeBudgetGuardStatus;
    if (!scopeBudget) {
        return;
    }
    lines.push(`ScopeBudgetGuardStatus: ${scopeBudget.status}`);
    lines.push(`ScopeBudgetGuardSummary: ${scopeBudget.summary_line}`);
    if (scopeBudget.preflight_path) {
        lines.push(`ScopeBudgetGuardPreflight: ${scopeBudget.preflight_path}`);
    }
    if (scopeBudget.continuation_allowed !== null) {
        lines.push(`ScopeBudgetGuardContinuationAllowed: ${scopeBudget.continuation_allowed ? 'yes' : 'no'}`);
    }
}

export function formatStatusSnapshot(snapshot: StatusSnapshot, options?: { heading?: string }): string {
    const heading = options?.heading || 'GARDA_STATUS';
    const lines: string[] = [
        heading,
        buildHeadlineText(snapshot),
        `Project: ${snapshot.targetRoot}`,
        `Bundle: ${snapshot.bundlePath}`,
        `InitAnswers: ${snapshot.initAnswersResolvedPath}`,
        `CollectedVia: ${snapshot.collectedVia || 'n/a'}`
    ];

    if (snapshot.activeAgentFiles) {
        lines.push(`ActiveAgentFiles: ${snapshot.activeAgentFiles}`);
    }
    lines.push(
        `SourceOfTruth: ${snapshot.sourceOfTruth || 'n/a'}`
        + `${snapshot.canonicalEntrypoint ? ` -> ${snapshot.canonicalEntrypoint}` : ''}`
    );
    if (snapshot.activeProfile) {
        lines.push(`ActiveProfile: ${snapshot.activeProfile}`);
    }
    if (snapshot.mandatoryFullSuiteEnabled !== null) {
        lines.push(`MandatoryFullSuite: ${snapshot.mandatoryFullSuiteEnabled ? 'enabled' : 'disabled'}`);
    }
    if (snapshot.mandatoryFullSuiteCommand) {
        lines.push(`MandatoryFullSuiteCommand: ${snapshot.mandatoryFullSuiteCommand}`);
    }
    if (snapshot.mandatoryFullSuitePerformance) {
        lines.push(`MandatoryFullSuitePerformance: ${snapshot.mandatoryFullSuitePerformance}`);
    }

    lines.push('');
    lines.push('Workspace Stages');
    lines.push(`  ${buildBadge(snapshot.bundlePresent)} Installed`);
    lines.push(`  ${buildBadge(snapshot.primaryInitializationComplete, { warning: snapshot.bundlePresent && !snapshot.primaryInitializationComplete })} Primary initialization`);
    lines.push(`  ${buildBadge(snapshot.agentInitializationComplete, { warning: snapshot.primaryInitializationComplete && !snapshot.agentInitializationComplete })} Agent initialization`);

    appendParityLines(lines, snapshot);
    appendProviderComplianceLines(lines, snapshot);
    appendProtectedManifestLines(lines, snapshot);

    lines.push(`  ${buildBadge(snapshot.readyForTasks, { warning: snapshot.agentInitializationComplete && !snapshot.readyForTasks })} Ready for task execution`);

    const pendingCheckpointLine = buildPendingCheckpointLine(snapshot);
    if (pendingCheckpointLine) {
        lines.push(pendingCheckpointLine);
    }
    if (snapshot.agentInitializationPendingReason === 'PROJECT_MEMORY_PENDING') {
        lines.push(`ProjectMemoryInitRefreshPrompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`);
    }
    if (snapshot.initAnswersError) {
        lines.push(`InitAnswersStatus: INVALID (${snapshot.initAnswersError})`);
    }
    if (snapshot.liveVersionError) {
        lines.push(`LiveVersionStatus: INVALID (${snapshot.liveVersionError})`);
    }
    if (snapshot.agentInitStateError) {
        lines.push(`AgentInitStateStatus: INVALID (${snapshot.agentInitStateError})`);
    }

    appendTimelineLines(lines, snapshot);
    appendScopeBudgetLines(lines, snapshot);
    appendToxinLines(lines, snapshot);
    appendCommandsLines(lines, snapshot);

    lines.push(`RecommendedUiCommand: ${snapshot.recommendedUiCommand || 'garda ui --actions'}`);
    lines.push(`RecommendedNextCommand: ${snapshot.recommendedNextCommand}`);
    return lines.join('\n');
}

export function formatStatusSnapshotCompact(snapshot: StatusSnapshot): string {
    if (!snapshot.readyForTasks) {
        return formatStatusSnapshot(snapshot);
    }
    const profileSuffix = snapshot.activeProfile ? ` | profile=${snapshot.activeProfile}` : '';
    const toxinSuffix = snapshot.toxinMetricsSummary && snapshot.toxinMetricsSummary.warnings.length > 0
        ? ` | toxin_warnings=${snapshot.toxinMetricsSummary.warnings.length}`
        : '';
    return `GARDA_STATUS: ready | source=${snapshot.sourceOfTruth || 'n/a'}${profileSuffix}${toxinSuffix}`;
}

export function formatStatusSnapshotJson(snapshot: StatusSnapshot): string {
    return JSON.stringify(snapshot, null, 2);
}
