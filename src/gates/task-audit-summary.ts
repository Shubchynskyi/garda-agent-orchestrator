import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId, inspectTaskEventFile } from '../gate-runtime/task-events';
import { fileSha256, joinOrchestratorPath, resolvePathInsideRepo, toPosix } from './helpers';
import { formatTimestamp, parseTimestamp } from './task-events-summary';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskAuditSummaryOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

interface GateOutcome {
    gate: string;
    status: 'PASS' | 'FAIL' | 'MISSING';
    event_type?: string;
    timestamp_utc?: string | null;
    artifact_path?: string | null;
}

interface EvidenceArtifact {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

interface BlockerEntry {
    gate: string;
    reason: string;
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
}

interface ProfileReviewDecisionSummary {
    profile_name: string | null;
    scope_category: string | null;
    guardrails_active: boolean;
    lightening_eligible: boolean;
    safety_floors_applied: string[];
    decisions: Array<{
        review_type: string;
        effective_value: boolean;
        decision: string;
    }>;
}

// ---------------------------------------------------------------------------
// Lifecycle gate ordering used for audit
// ---------------------------------------------------------------------------

const LIFECYCLE_GATES: ReadonlyArray<{ gate: string; pass_event: string; fail_events: string[] }> = [
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
// Helpers
// ---------------------------------------------------------------------------

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function resolveReviewsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
}

function resolveEventsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

export function buildTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);

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

    for (const { gate, pass_event, fail_events } of LIFECYCLE_GATES) {
        // Also accept REVIEW_GATE_PASSED_WITH_OVERRIDE as a pass
        const passEvents = [pass_event];
        if (pass_event === 'REVIEW_GATE_PASSED') {
            passEvents.push('REVIEW_GATE_PASSED_WITH_OVERRIDE');
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

    const preflightPath = path.join(reviewsRoot, `${safeTaskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    if (preflight) {
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
    const hasIntegrityFailure = integrityStatus === 'FAILED';

    if (hasIntegrityFailure) {
        blockers.push({
            gate: 'integrity',
            reason: `Task event timeline integrity check returned ${integrityStatus}`
        });
    }

    let status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    if (hasCompletionPass && blockers.length === 0 && !hasIntegrityFailure) {
        status = 'PASS';
    } else if (hasFailedGate || blockers.length > 0) {
        status = 'BLOCKED';
    } else {
        status = 'INCOMPLETE';
    }

    return {
        task_id: safeTaskId,
        generated_utc: new Date().toISOString(),
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
        blockers
    };
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

export function formatTaskAuditSummaryText(summary: TaskAuditSummaryResult): string {
    const lines: string[] = [];

    lines.push(`Task: ${summary.task_id}`);
    lines.push(`Status: ${summary.status}`);
    lines.push(`Events: ${summary.events_count}`);
    lines.push(`Integrity: ${summary.integrity_status}`);
    if (summary.first_event_utc) lines.push(`FirstEvent: ${summary.first_event_utc}`);
    if (summary.last_event_utc) lines.push(`LastEvent: ${summary.last_event_utc}`);

    // Gates
    lines.push('');
    lines.push('Gates:');
    for (const gate of summary.gates) {
        const marker = gate.status === 'PASS' ? '[+]' : gate.status === 'FAIL' ? '[X]' : '[ ]';
        const ts = gate.timestamp_utc ? ` (${gate.timestamp_utc})` : '';
        lines.push(`  ${marker} ${gate.gate}${ts}`);
    }

    // Changed files
    lines.push('');
    lines.push(`ChangedFiles: ${summary.changed_files_count} (${summary.changed_lines_total} lines)`);
    for (const file of summary.changed_files) {
        lines.push(`  - ${file}`);
    }

    // Required reviews
    const activeReviews = Object.entries(summary.required_reviews)
        .filter(([, v]) => v)
        .map(([k]) => k);
    if (activeReviews.length > 0) {
        lines.push('');
        lines.push(`RequiredReviews: ${activeReviews.join(', ')}`);
    }

    // Scope category
    if (summary.scope_category) {
        lines.push(`ScopeCategory: ${summary.scope_category}`);
    }

    // Profile review decisions
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

    // Evidence (always shown to expose expected artifact paths)
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

    // Blockers
    if (summary.blockers.length > 0) {
        lines.push('');
        lines.push('Blockers:');
        for (const b of summary.blockers) {
            lines.push(`  [!] ${b.gate}: ${b.reason}`);
        }
    }

    return lines.join('\n');
}
