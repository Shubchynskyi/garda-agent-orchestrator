import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId, inspectTaskEventFile } from '../gate-runtime/task-events';
import { inspectCompletionGateFinalizationLock, type CompletionGateFinalizationLockPolicy } from './finalization-lock';
import { fileSha256, toPosix } from './helpers';
import { buildTokenEconomySummary, formatTimestamp, parseTimestamp } from './task-events-summary';
import { readOptionalSkillSelectionTimelineEvidence } from '../runtime/optional-skill-selection';
import { resolveFullSuiteValidationRequirementForOrderedTaskEvents } from '../gate-runtime/lifecycle-event-types';
import { loadFullSuiteValidationConfig } from './full-suite-validation';
import {
    type BlockerEntry,
    type EvidenceArtifact,
    type FinalCloseoutArtifactPaths,
    type FinalCloseoutDocsSummary,
    type FinalCloseoutImplementationSummary,
    type FinalCloseoutOptionalSkillsSummary,
    type FinalReportContract,
    type GateOutcome,
    type ProfileReviewDecisionSummary,
    type TaskQueueMetadata,
    parseOptionalNumber,
    readDocImpactSummary,
    readOptionalSkillsSummary,
    readReviewVerdicts,
    readTaskQueueMetadata,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson,
    updateEvidenceArtifactState
} from './task-audit-summary-collectors';
import { buildCommitCommandSuggestion, formatFinalCloseoutMarkdown } from './task-audit-summary-renderers';
export { formatFinalCloseoutMarkdown, formatTaskAuditSummaryText } from './task-audit-summary-renderers';

// ---------------------------------------------------------------------------
// Types — public composite shapes used by external consumers
// ---------------------------------------------------------------------------

export interface TaskAuditSummaryOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

export interface FinalCloseoutArtifact {
    schema_version: 1;
    event_source: 'task-audit-summary';
    task_id: string;
    generated_utc: string;
    audit_status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    status: 'READY' | 'NOT_READY';
    blocker: string | null;
    artifact_state: 'PENDING' | 'MATERIALIZED' | 'REMOVED' | 'NOT_READY';
    artifact_paths: FinalCloseoutArtifactPaths;
    implementation_summary: FinalCloseoutImplementationSummary;
    optional_skills?: FinalCloseoutOptionalSkillsSummary | null;
    workflow?: {
        mandatory_full_suite_enabled: boolean;
        visible_summary_line: string;
    } | null;
    docs: FinalCloseoutDocsSummary;
    token_economy: ReturnType<typeof buildTokenEconomySummary> | null;
    commit_command_template: string;
    commit_command_suggestion: string;
    commit_question: string;
}

export interface TaskAuditSummaryResult {
    task_id: string;
    generated_utc: string;
    status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    events_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    integrity_status: string;
    gates: GateOutcome[];
    changed_files: string[];
    changed_files_count: number;
    changed_lines_total: number;
    required_reviews: Record<string, boolean>;
    scope_category: string | null;
    profile_review_decisions: ProfileReviewDecisionSummary | null;
    evidence: EvidenceArtifact[];
    blockers: BlockerEntry[];
    point_in_time_snapshot: PointInTimeSnapshot;
    final_report_contract: FinalReportContract;
    final_closeout: FinalCloseoutArtifact;
}

export interface PointInTimeSnapshot {
    status: 'STABLE' | 'FINALIZATION_IN_FLIGHT';
    gate: 'completion-gate' | null;
    message: string | null;
    recommended_action: string | null;
    lock_path: string | null;
    owner_pid?: number | null;
    owner_hostname?: string | null;
    owner_created_at_utc?: string | null;
    owner_alive?: boolean | null;
    owner_metadata_status?: string | null;
    stale_reason?: string | null;
    subsystem_scope_note?: string | null;
    acquisition_policy?: CompletionGateFinalizationLockPolicy | null;
}

// ---------------------------------------------------------------------------
// Lifecycle gate ordering used for audit
// ---------------------------------------------------------------------------

const BASE_LIFECYCLE_GATES: ReadonlyArray<{ gate: string; pass_event: string; fail_events: string[] }> = [
    { gate: 'enter-task-mode', pass_event: 'TASK_MODE_ENTERED', fail_events: [] },
    { gate: 'load-rule-pack', pass_event: 'RULE_PACK_LOADED', fail_events: ['RULE_PACK_LOAD_FAILED'] },
    { gate: 'handshake-diagnostics', pass_event: 'HANDSHAKE_DIAGNOSTICS_RECORDED', fail_events: [] },
    { gate: 'shell-smoke-preflight', pass_event: 'SHELL_SMOKE_PREFLIGHT_RECORDED', fail_events: [] },
    { gate: 'classify-change', pass_event: 'PREFLIGHT_CLASSIFIED', fail_events: ['PREFLIGHT_FAILED'] },
    { gate: 'compile-gate', pass_event: 'COMPILE_GATE_PASSED', fail_events: ['COMPILE_GATE_FAILED'] },
    { gate: 'review-phase', pass_event: 'REVIEW_PHASE_STARTED', fail_events: [] },
    { gate: 'required-reviews-check', pass_event: 'REVIEW_GATE_PASSED', fail_events: ['REVIEW_GATE_FAILED'] },
    { gate: 'doc-impact-gate', pass_event: 'DOC_IMPACT_ASSESSED', fail_events: ['DOC_IMPACT_ASSESSMENT_FAILED'] },
    { gate: 'completion-gate', pass_event: 'COMPLETION_GATE_PASSED', fail_events: ['COMPLETION_GATE_FAILED'] }
];

function getLifecycleGates(fullSuiteValidationEnabled: boolean): Array<{ gate: string; pass_event: string; fail_events: string[] }> {
    const gates = BASE_LIFECYCLE_GATES.map((entry) => ({
        gate: entry.gate,
        pass_event: entry.pass_event,
        fail_events: [...entry.fail_events]
    }));
    if (!fullSuiteValidationEnabled) {
        return gates;
    }

    const completionIndex = gates.findIndex((entry) => entry.gate === 'completion-gate');
    const fullSuiteGate = {
        gate: 'full-suite-validation',
        pass_event: 'FULL_SUITE_VALIDATION_PASSED',
        fail_events: ['FULL_SUITE_VALIDATION_FAILED', 'FULL_SUITE_VALIDATION_SKIPPED']
    };
    if (completionIndex === -1) {
        gates.push(fullSuiteGate);
    } else {
        gates.splice(completionIndex, 0, fullSuiteGate);
    }
    return gates;
}

// Artifact name patterns relative to reviews root, keyed by kind.
const ARTIFACT_PATTERNS: ReadonlyArray<{ kind: string; suffix: string }> = [
    { kind: 'task-mode', suffix: '-task-mode.json' },
    { kind: 'rule-pack', suffix: '-rule-pack.json' },
    { kind: 'handshake', suffix: '-handshake.json' },
    { kind: 'shell-smoke', suffix: '-shell-smoke.json' },
    { kind: 'preflight', suffix: '-preflight.json' },
    { kind: 'compile-gate', suffix: '-compile-gate.json' },
    { kind: 'compile-output', suffix: '-compile-output.log' },
    { kind: 'review-gate', suffix: '-review-gate.json' },
    { kind: 'doc-impact', suffix: '-doc-impact.json' },
    { kind: 'full-suite-validation', suffix: '-full-suite-validation.json' },
    { kind: 'full-suite-output', suffix: '-full-suite-output.log' },
    { kind: 'optional-skill-selection', suffix: '-optional-skill-selection.json' },
    { kind: 'final-closeout-json', suffix: '-final-closeout.json' },
    { kind: 'final-closeout-markdown', suffix: '-final-closeout.md' },
    { kind: 'no-op', suffix: '-no-op.json' },
    { kind: 'code-review', suffix: '-code.md' },
    { kind: 'code-review-context', suffix: '-code-review-context.json' },
    { kind: 'code-receipt', suffix: '-code-receipt.json' },
    { kind: 'db-review', suffix: '-db.md' },
    { kind: 'db-review-context', suffix: '-db-review-context.json' },
    { kind: 'db-receipt', suffix: '-db-receipt.json' },
    { kind: 'security-review', suffix: '-security.md' },
    { kind: 'security-review-context', suffix: '-security-review-context.json' },
    { kind: 'security-receipt', suffix: '-security-receipt.json' },
    { kind: 'refactor-review', suffix: '-refactor.md' },
    { kind: 'refactor-review-context', suffix: '-refactor-review-context.json' },
    { kind: 'refactor-receipt', suffix: '-refactor-receipt.json' },
    { kind: 'test-review', suffix: '-test.md' },
    { kind: 'test-review-context', suffix: '-test-review-context.json' },
    { kind: 'test-receipt', suffix: '-test-receipt.json' },
    { kind: 'api-review', suffix: '-api.md' },
    { kind: 'api-review-context', suffix: '-api-review-context.json' },
    { kind: 'api-receipt', suffix: '-api-receipt.json' },
    { kind: 'performance-review', suffix: '-performance.md' },
    { kind: 'performance-review-context', suffix: '-performance-review-context.json' },
    { kind: 'performance-receipt', suffix: '-performance-receipt.json' },
    { kind: 'infra-review', suffix: '-infra.md' },
    { kind: 'infra-review-context', suffix: '-infra-review-context.json' },
    { kind: 'infra-receipt', suffix: '-infra-receipt.json' },
    { kind: 'dependency-review', suffix: '-dependency.md' },
    { kind: 'dependency-review-context', suffix: '-dependency-review-context.json' },
    { kind: 'dependency-receipt', suffix: '-dependency-receipt.json' }
];

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

export function buildTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const liveFullSuiteValidationEnabled = loadFullSuiteValidationConfig(repoRoot).enabled;
    const taskMetadata = readTaskQueueMetadata(repoRoot, safeTaskId);
    const taskPath = path.join(repoRoot, 'TASK.md');
    const taskFileExists = fs.existsSync(taskPath) && fs.statSync(taskPath).isFile();

    // -----------------------------------------------------------------------
    // 1. Parse task events timeline
    // -----------------------------------------------------------------------
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);
    const events: Record<string, unknown>[] = [];
    let eventsCount = 0;

    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        const rawLines = fs.readFileSync(taskEventFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        for (const line of rawLines) {
            try {
                const event = JSON.parse(line);
                if (event != null) events.push(event);
            } catch {
                // skip parse errors
            }
        }
    }

    events.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp_utc);
        const tb = parseTimestamp(b.timestamp_utc);
        return ta.getTime() - tb.getTime();
    });

    eventsCount = events.length;
    const firstEventUtc = eventsCount > 0 ? formatTimestamp(events[0].timestamp_utc) : null;
    const lastEventUtc = eventsCount > 0 ? formatTimestamp(events[eventsCount - 1].timestamp_utc) : null;

    // Build a set of event types present
    const eventTypesPresent = new Set<string>();
    const eventByType = new Map<string, Record<string, unknown>>();
    for (const event of events) {
        const eventType = String(event.event_type || '');
        eventTypesPresent.add(eventType);
        // Keep last occurrence per type
        eventByType.set(eventType, event);
    }
    const fullSuiteValidationEnabled = resolveFullSuiteValidationRequirementForOrderedTaskEvents(
        events.map((event) => String(event.event_type || '')),
        liveFullSuiteValidationEnabled
    ).required;
    const lifecycleGates = getLifecycleGates(fullSuiteValidationEnabled);

    // -----------------------------------------------------------------------
    // 2. Integrity check
    // -----------------------------------------------------------------------
    let integrityStatus = 'UNKNOWN';
    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        try {
            const report = inspectTaskEventFile(taskEventFile, safeTaskId);
            integrityStatus = report.status;
        } catch {
            integrityStatus = 'ERROR';
        }
    } else {
        integrityStatus = 'MISSING';
    }

    // -----------------------------------------------------------------------
    // 3. Gate outcomes
    // -----------------------------------------------------------------------
    const gates: GateOutcome[] = [];
    const blockers: BlockerEntry[] = [];
    let pointInTimeSnapshot: PointInTimeSnapshot = {
        status: 'STABLE',
        gate: null,
        message: null,
        recommended_action: null,
        lock_path: null,
        owner_pid: null,
        owner_hostname: null,
        owner_created_at_utc: null,
        owner_alive: null,
        owner_metadata_status: null,
        stale_reason: null,
        subsystem_scope_note: null,
        acquisition_policy: null
    };

    for (const { gate, pass_event, fail_events } of lifecycleGates) {
        // Also accept REVIEW_GATE_PASSED_WITH_OVERRIDE as a pass
        const passEvents = [pass_event];
        if (pass_event === 'REVIEW_GATE_PASSED') {
            passEvents.push('REVIEW_GATE_PASSED_WITH_OVERRIDE');
        } else if (pass_event === 'FULL_SUITE_VALIDATION_PASSED') {
            passEvents.push('FULL_SUITE_VALIDATION_WARNED');
        }

        // Find latest pass and latest fail
        let latestPass: Record<string, unknown> | undefined;
        let latestPassType: string | undefined;
        for (const pe of passEvents) {
            if (eventTypesPresent.has(pe)) {
                const evt = eventByType.get(pe)!;
                if (!latestPass || parseTimestamp(evt.timestamp_utc).getTime() > parseTimestamp(latestPass.timestamp_utc).getTime()) {
                    latestPass = evt;
                    latestPassType = pe;
                }
            }
        }

        let latestFail: Record<string, unknown> | undefined;
        let latestFailType: string | undefined;
        for (const fe of fail_events) {
            if (eventTypesPresent.has(fe)) {
                const evt = eventByType.get(fe)!;
                if (!latestFail || parseTimestamp(evt.timestamp_utc).getTime() > parseTimestamp(latestFail.timestamp_utc).getTime()) {
                    latestFail = evt;
                    latestFailType = fe;
                }
            }
        }

        // Use whichever is more recent
        if (latestPass && latestFail) {
            const passTime = parseTimestamp(latestPass.timestamp_utc).getTime();
            const failTime = parseTimestamp(latestFail.timestamp_utc).getTime();
            if (failTime > passTime) {
                gates.push({
                    gate,
                    status: 'FAIL',
                    event_type: latestFailType,
                    timestamp_utc: formatTimestamp(latestFail.timestamp_utc)
                });
                blockers.push({ gate, reason: `Gate emitted ${latestFailType} after earlier pass` });
            } else {
                gates.push({
                    gate,
                    status: 'PASS',
                    event_type: latestPassType,
                    timestamp_utc: formatTimestamp(latestPass.timestamp_utc)
                });
            }
        } else if (latestPass) {
            gates.push({
                gate,
                status: 'PASS',
                event_type: latestPassType,
                timestamp_utc: formatTimestamp(latestPass.timestamp_utc)
            });
        } else if (latestFail) {
            gates.push({
                gate,
                status: 'FAIL',
                event_type: latestFailType,
                timestamp_utc: formatTimestamp(latestFail.timestamp_utc)
            });
            blockers.push({ gate, reason: `Gate emitted ${latestFailType}` });
        } else {
            gates.push({ gate, status: 'MISSING', event_type: pass_event });
        }
    }

    // -----------------------------------------------------------------------
    // 4. Changed files from preflight
    // -----------------------------------------------------------------------
    let changedFiles: string[] = [];
    let changedFilesCount = 0;
    let changedLinesTotal = 0;
    let requiredReviews: Record<string, boolean> = {};
    let scopeCategory: string | null = null;
    let pathMode: string | null = null;

    const preflightPath = path.join(reviewsRoot, `${safeTaskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    const preflightSha256 = fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null;
    if (preflight) {
        if (typeof preflight.mode === 'string' && preflight.mode.trim()) {
            pathMode = preflight.mode.trim();
        }
        if (Array.isArray(preflight.changed_files)) {
            changedFiles = preflight.changed_files.map((f: unknown) => String(f));
            changedFilesCount = changedFiles.length;
        }
        const metrics = preflight.metrics as Record<string, unknown> | null | undefined;
        if (metrics && typeof metrics === 'object') {
            changedLinesTotal = Number(metrics.changed_lines_total) || 0;
        }
        if (preflight.required_reviews && typeof preflight.required_reviews === 'object') {
            const rr = preflight.required_reviews as Record<string, unknown>;
            for (const [key, val] of Object.entries(rr)) {
                requiredReviews[key] = val === true;
            }
        }
        if (typeof preflight.scope_category === 'string') {
            scopeCategory = preflight.scope_category;
        }
    }

    // -----------------------------------------------------------------------
    // 4b. Profile review decisions from task-mode artifact
    // -----------------------------------------------------------------------
    let profileReviewDecisions: ProfileReviewDecisionSummary | null = null;
    const taskModePath = path.join(reviewsRoot, `${safeTaskId}-task-mode.json`);
    const taskMode = safeReadJson(taskModePath);
    if (taskMode && typeof taskMode.active_profile === 'string' && taskMode.active_profile) {
        const decisions: Array<{ review_type: string; effective_value: boolean; decision: string }> = [];
        // Extract profile review decisions from preflight if guardrail data is present
        if (preflight && preflight.profile_guardrails && typeof preflight.profile_guardrails === 'object') {
            const guardrails = preflight.profile_guardrails as Record<string, unknown>;
            const rawDecisions = guardrails.decisions;
            if (Array.isArray(rawDecisions)) {
                for (const d of rawDecisions) {
                    if (d && typeof d === 'object') {
                        const dObj = d as Record<string, unknown>;
                        decisions.push({
                            review_type: String(dObj.review_type || ''),
                            effective_value: dObj.effective_value === true,
                            decision: String(dObj.decision || '')
                        });
                    }
                }
            }
            const safetyFloors: string[] = [];
            if (Array.isArray(guardrails.safety_floors_applied)) {
                for (const f of guardrails.safety_floors_applied) {
                    safetyFloors.push(String(f));
                }
            }
            profileReviewDecisions = {
                profile_name: String(taskMode.active_profile || ''),
                scope_category: scopeCategory,
                guardrails_active: guardrails.guardrails_active === true,
                lightening_eligible: guardrails.lightening_eligible === true,
                safety_floors_applied: safetyFloors,
                decisions
            };
        } else {
            profileReviewDecisions = {
                profile_name: String(taskMode.active_profile || ''),
                scope_category: scopeCategory,
                guardrails_active: false,
                lightening_eligible: false,
                safety_floors_applied: [],
                decisions
            };
        }
    }

    // Check required review evidence: receipt + review markdown must both exist,
    // receipt must parse, and receipt integrity fields must be consistent.
    // Schema v2 receipts do not carry a verdict field; the passing verdict lives
    // in the review markdown and is validated by required-reviews-check.  Here we
    // verify artifact-level integrity only: task_id, review_type, and
    // review_artifact_sha256 must match the actual review file on disk.

    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) continue;
        const receiptPath = path.join(reviewsRoot, `${safeTaskId}-${reviewType}-receipt.json`);
        const reviewPath = path.join(reviewsRoot, `${safeTaskId}-${reviewType}.md`);
        const hasReceiptFile = fs.existsSync(receiptPath);
        const hasReview = fs.existsSync(reviewPath);

        if (!hasReceiptFile && !hasReview) {
            blockers.push({
                gate: `${reviewType}-review`,
                reason: `Required ${reviewType} review artifact not found`
            });
        } else if (!hasReceiptFile) {
            blockers.push({
                gate: `${reviewType}-review`,
                reason: `Required ${reviewType} review receipt not found (review markdown exists but receipt is missing)`
            });
        } else if (!hasReview) {
            blockers.push({
                gate: `${reviewType}-review`,
                reason: `Required ${reviewType} review markdown not found (receipt exists but review document is missing)`
            });
        } else {
            const receipt = safeReadJson(receiptPath);
            if (!receipt) {
                blockers.push({
                    gate: `${reviewType}-review`,
                    reason: `Required ${reviewType} review receipt is malformed or unreadable`
                });
            } else if (receipt.task_id !== safeTaskId) {
                blockers.push({
                    gate: `${reviewType}-review`,
                    reason: `Required ${reviewType} review receipt belongs to a different task: ${receipt.task_id}`
                });
            } else if (receipt.review_type !== reviewType) {
                blockers.push({
                    gate: `${reviewType}-review`,
                    reason: `Required ${reviewType} review receipt has mismatched review type: ${receipt.review_type}`
                });
            } else if (typeof receipt.review_artifact_sha256 === 'string' && receipt.review_artifact_sha256) {
                const actualHash = fileSha256(reviewPath);
                if (actualHash && receipt.review_artifact_sha256 !== actualHash) {
                    blockers.push({
                        gate: `${reviewType}-review`,
                        reason: `Required ${reviewType} review artifact was modified after receipt was issued`
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 5. Evidence artifacts
    // -----------------------------------------------------------------------
    const tokenEconomy = buildTokenEconomySummary(events, repoRoot);
    const evidence: EvidenceArtifact[] = [];
    for (const { kind, suffix } of ARTIFACT_PATTERNS) {
        const artifactPath = path.join(reviewsRoot, `${safeTaskId}${suffix}`);
        const exists = fs.existsSync(artifactPath);
        evidence.push({
            kind,
            path: toPosix(artifactPath),
            exists,
            sha256: exists ? fileSha256(artifactPath) : null
        });
    }

    // Also include the task events file
    evidence.push({
        kind: 'task-events',
        path: toPosix(taskEventFile),
        exists: fs.existsSync(taskEventFile),
        sha256: fs.existsSync(taskEventFile) ? fileSha256(taskEventFile) : null
    });

    // -----------------------------------------------------------------------
    // 6. Determine overall status
    // -----------------------------------------------------------------------
    const hasCompletionPass = gates.some(
        (g) => g.gate === 'completion-gate' && g.status === 'PASS'
    );
    const hasFailedGate = gates.some((g) => g.status === 'FAIL');
    const failedGateNames = gates.filter((g) => g.status === 'FAIL').map((g) => g.gate);
    const hasNonCompletionFailure = failedGateNames.some((gateName) => gateName !== 'completion-gate');
    const hasIntegrityFailure = integrityStatus === 'FAILED';
    const completionGateLock = inspectCompletionGateFinalizationLock(reviewsRoot, safeTaskId);
    if (completionGateLock.active || completionGateLock.stale) {
        const ownerPidText = completionGateLock.owner_pid === null ? 'unknown' : String(completionGateLock.owner_pid);
        const ownerHostText = completionGateLock.owner_hostname || 'unknown';
        pointInTimeSnapshot = {
            status: 'FINALIZATION_IN_FLIGHT',
            gate: 'completion-gate',
            message: completionGateLock.active
                ? `Completion gate finalization is currently in flight under PID ${ownerPidText} on ${ownerHostText}, so this audit summary is a point-in-time snapshot and may still reflect an older completion result.`
                : `Completion finalization lock is stale (${completionGateLock.stale_reason || 'unknown reason'}, metadata=${completionGateLock.owner_metadata_status}) for PID ${ownerPidText} on ${ownerHostText}, so this audit summary is treated as a point-in-time snapshot and may still reflect an older completion result.`,
            recommended_action: completionGateLock.active
                ? `Re-run task-audit-summary sequentially after completion-gate finishes. ${completionGateLock.remediation}`
                : completionGateLock.remediation,
            lock_path: toPosix(completionGateLock.lock_path),
            owner_pid: completionGateLock.owner_pid,
            owner_hostname: completionGateLock.owner_hostname,
            owner_created_at_utc: completionGateLock.owner_created_at_utc,
            owner_alive: completionGateLock.owner_alive,
            owner_metadata_status: completionGateLock.owner_metadata_status,
            stale_reason: completionGateLock.stale_reason,
            subsystem_scope_note: completionGateLock.subsystem_scope_note,
            acquisition_policy: completionGateLock.acquisition_policy
        };
    }

    if (hasIntegrityFailure) {
        blockers.push({
            gate: 'integrity',
            reason: `Task event timeline integrity check returned ${integrityStatus}`
        });
    }

    const hasNonCompletionBlockers = blockers.some((blocker) => blocker.gate !== 'completion-gate');
    if (
        pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT'
        && !hasIntegrityFailure
        && !hasNonCompletionBlockers
        && !hasNonCompletionFailure
    ) {
        for (let index = blockers.length - 1; index >= 0; index--) {
            if (blockers[index].gate === 'completion-gate') {
                blockers.splice(index, 1);
            }
        }
    }

    let status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    if (pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT') {
        status = !hasIntegrityFailure && blockers.length === 0 && !hasNonCompletionFailure
            ? 'INCOMPLETE'
            : 'BLOCKED';
    } else if (hasCompletionPass && blockers.length === 0 && !hasIntegrityFailure) {
        status = 'PASS';
    } else if (hasFailedGate || blockers.length > 0) {
        status = 'BLOCKED';
    } else {
        status = 'INCOMPLETE';
    }

    const commitCommand = buildCommitCommandSuggestion(changedFiles, taskMetadata);
    const reviewGatePath = path.join(reviewsRoot, `${safeTaskId}-review-gate.json`);
    const reviewGate = safeReadJson(reviewGatePath);
    const reviewVerdicts = readReviewVerdicts(requiredReviews, reviewGate);
    const docImpactPath = path.join(reviewsRoot, `${safeTaskId}-doc-impact.json`);
    const docImpact = safeReadJson(docImpactPath);
    const docsSummary = readDocImpactSummary(docImpact);
    const optionalSkillsPath = path.join(reviewsRoot, `${safeTaskId}-optional-skill-selection.json`);
    const bundleRoot = path.dirname(path.dirname(reviewsRoot));
    const taskEventsTimelineEvidence = readOptionalSkillSelectionTimelineEvidence(bundleRoot, safeTaskId, taskEventFile);
    const optionalSkillsSummary = readOptionalSkillsSummary(
        bundleRoot,
        preflightPath,
        preflightSha256,
        taskMetadata?.title || null,
        taskFileExists && taskMetadata == null,
        optionalSkillsPath,
        safeReadJson(optionalSkillsPath),
        taskEventsTimelineEvidence
    );
    const finalCloseoutJsonPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.json`);
    const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.md`);
    const finalReportContract: FinalReportContract = {
        status: status === 'PASS' ? 'READY' : 'NOT_READY',
        blocker: status === 'PASS'
            ? null
            : pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT' && status === 'INCOMPLETE'
                ? `${pointInTimeSnapshot.message} ${pointInTimeSnapshot.recommended_action}`
                : 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
        required_order: [
            'implementation summary',
            commitCommand.suggestion,
            'Do you want me to commit now? (yes/no)'
        ],
        implementation_summary_requirements: [
            'depth',
            'path mode',
            'review verdicts',
            'docs updated'
        ],
        commit_command_template: commitCommand.template,
        commit_command_suggestion: commitCommand.suggestion,
        commit_question: 'Do you want me to commit now? (yes/no)'
    };
    const finalCloseout: FinalCloseoutArtifact = {
        schema_version: 1,
        event_source: 'task-audit-summary',
        task_id: safeTaskId,
        generated_utc: new Date().toISOString(),
        audit_status: status,
        status: finalReportContract.status,
        blocker: finalReportContract.blocker,
        artifact_state: status === 'PASS' ? 'PENDING' : 'NOT_READY',
        artifact_paths: {
            json: toPosix(finalCloseoutJsonPath),
            markdown: toPosix(finalCloseoutMarkdownPath)
        },
        implementation_summary: {
            requested_depth: parseOptionalNumber(taskMode?.requested_depth),
            effective_depth: parseOptionalNumber(taskMode?.effective_depth),
            path_mode: pathMode,
            review_verdicts: reviewVerdicts,
            docs_updated: docsSummary.decision === 'DOCS_UPDATED',
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            scope_category: scopeCategory,
            active_profile: typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim()
                ? taskMode.active_profile.trim()
                : null
        },
        optional_skills: optionalSkillsSummary,
        workflow: {
            mandatory_full_suite_enabled: fullSuiteValidationEnabled,
            visible_summary_line: `Mandatory full-suite: ${fullSuiteValidationEnabled ? 'true' : 'false'}`
        },
        docs: docsSummary,
        token_economy: tokenEconomy,
        commit_command_template: commitCommand.template,
        commit_command_suggestion: commitCommand.suggestion,
        commit_question: finalReportContract.commit_question
    };

    return {
        task_id: safeTaskId,
        generated_utc: finalCloseout.generated_utc,
        status,
        events_count: eventsCount,
        first_event_utc: firstEventUtc,
        last_event_utc: lastEventUtc,
        integrity_status: integrityStatus,
        gates,
        changed_files: changedFiles,
        changed_files_count: changedFilesCount,
        changed_lines_total: changedLinesTotal,
        required_reviews: requiredReviews,
        scope_category: scopeCategory,
        profile_review_decisions: profileReviewDecisions,
        evidence,
        blockers,
        point_in_time_snapshot: pointInTimeSnapshot,
        final_report_contract: finalReportContract,
        final_closeout: finalCloseout
    };
}

// ---------------------------------------------------------------------------
// Final closeout artifact
// ---------------------------------------------------------------------------

export function synchronizeFinalCloseoutArtifacts(summary: TaskAuditSummaryResult): TaskAuditSummaryResult {
    const jsonPath = summary.final_closeout.artifact_paths.json;
    const markdownPath = summary.final_closeout.artifact_paths.markdown;

    if (summary.final_closeout.status === 'READY') {
        const closeout = {
            ...summary.final_closeout,
            artifact_state: 'MATERIALIZED' as const
        };
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(closeout, null, 2) + '\n', 'utf8');
        fs.writeFileSync(markdownPath, formatFinalCloseoutMarkdown(closeout) + '\n', 'utf8');
        summary.final_closeout = closeout;
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, true);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, true);
        return summary;
    }

    if (summary.point_in_time_snapshot.status === 'FINALIZATION_IN_FLIGHT') {
        const jsonExists = fs.existsSync(jsonPath);
        const markdownExists = fs.existsSync(markdownPath);
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: jsonExists || markdownExists ? 'MATERIALIZED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, jsonExists);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, markdownExists);
        return summary;
    }

    let removed = false;
    for (const artifactPath of [jsonPath, markdownPath]) {
        if (fs.existsSync(artifactPath)) {
            fs.rmSync(artifactPath, { force: true });
            removed = true;
        }
    }
    summary.final_closeout = {
        ...summary.final_closeout,
        artifact_state: removed ? 'REMOVED' : 'NOT_READY'
    };
    updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, false);
    updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, false);
    return summary;
}
