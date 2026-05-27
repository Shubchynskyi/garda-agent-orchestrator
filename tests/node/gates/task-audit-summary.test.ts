import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    spawn,
    createHash,
    execFileSync,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    ensureSkillsHeadlinesCurrent,
    getWorkspaceSnapshot,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    NODE_BACKEND_SKILL_SOURCE,
    computeFileSha256,
    computeTaskTextSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writePassedLifecycleWithReviewRecorded,
    writeWorkflowConfig,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    writeProjectMemoryImpactArtifact,
    writePathsConfig,
    writePassedLifecycle,
    makeIndependentReviewGateCheck,
    makeReviewerInvocationProvenance,
    makeDelegatedRouting,
    writeRequiredCodeScenario,
    buildCurrentTaskAuditSummary,
    assertReviewIntegrity,
    assertReviewIntegrityBlocksFinalCloseout,
    writeCurrentIndependentReviewFixture,
    initGitRepo,
    writeActiveCompletionLock,
    makeTempDir,
    type TaskAuditSummaryResult
} from './task-audit-summary-fixtures';
import { buildDomainScopeFingerprints } from '../../../src/gates/domain-scope-fingerprints';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {
        it('returns INCOMPLETE for task with no events', () => {
            // Create an empty events file
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.task_id, TASK_ID);
            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.events_count, 0);
            assert.ok(result.gates.length > 0);
            assert.ok(result.gates.every(g => g.status === 'MISSING'));
        });

        it('detects passed gates from events', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const taskModeGate = result.gates.find(g => g.gate === 'enter-task-mode');
            assert.ok(taskModeGate);
            assert.equal(taskModeGate.status, 'PASS');

            const rulePackGate = result.gates.find(g => g.gate === 'load-rule-pack');
            assert.ok(rulePackGate);
            assert.equal(rulePackGate.status, 'PASS');
        });

        it('includes project-memory-impact gate and final closeout project memory status', () => {
            writeProjectMemoryWorkflowConfig(tmpDir);
            seedProjectMemory(tmpDir);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            writeProjectMemoryImpactArtifact(tmpDir, TASK_ID);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find(g => g.gate === 'project-memory-impact')?.status, 'PASS');
            assert.equal(result.final_closeout.project_memory?.evidence_status, 'CURRENT');
            assert.equal(result.final_closeout.project_memory?.status, 'NO_UPDATE_NEEDED');
            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('Project memory: enabled; mode=check'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Project memory: enabled; mode=check'));
        });

        it('does not block final closeout on historical project-memory events after maintenance is disabled', () => {
            writeProjectMemoryWorkflowConfig(tmpDir);
            seedProjectMemory(tmpDir);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/app.ts'],
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            writeProjectMemoryImpactArtifact(tmpDir, TASK_ID);
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writeProjectMemoryWorkflowConfig(tmpDir, false);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'PASS');
            assert.equal(result.gates.some(g => g.gate === 'project-memory-impact'), false);
            assert.equal(result.final_closeout.project_memory?.evidence_status, 'NOT_REQUIRED');
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'project-memory-impact'), false);
        });

        it('reads changed files from preflight', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts', 'src/bar.ts'],
                metrics: { changed_lines_total: 42 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.changed_files, ['src/foo.ts', 'src/bar.ts']);
            assert.equal(result.changed_files_count, 2);
            assert.equal(result.changed_lines_total, 42);
            assert.equal(result.required_reviews.code, true);
            assert.equal(result.required_reviews.db, false);
        });

        it('accepts stale review receipts only when persisted domain fingerprints match current scope', () => {
            const changedFiles = ['src/gates/task-audit-summary.ts'];
            const currentPreflight = {
                detection_source: 'git_auto',
                include_untracked: true,
                changed_files: changedFiles,
                required_reviews: { code: true }
            };
            writePreflight(reviewsDir, TASK_ID, currentPreflight);
            const currentPreflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
            const stalePreflightSha256 = 'a'.repeat(64);
            const matchingDomainScopeFingerprints = buildDomainScopeFingerprints({
                repoRoot: tmpDir,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles
            });
            writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId: TASK_ID,
                preflightSha256: stalePreflightSha256,
                receiptOverrides: {
                    domain_scope_fingerprints: matchingDomainScopeFingerprints
                }
            });

            const matchingSummary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                currentPreflightSha256,
                currentPreflight,
                tmpDir
            );

            assert.equal(matchingSummary?.status, 'INDEPENDENT_AUDITED');

            const mismatchedDomainScopeFingerprints = buildDomainScopeFingerprints({
                repoRoot: tmpDir,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles: ['src/gates/next-step.ts']
            });
            writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId: TASK_ID,
                preflightSha256: stalePreflightSha256,
                receiptOverrides: {
                    domain_scope_fingerprints: mismatchedDomainScopeFingerprints
                }
            });

            const mismatchedSummary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                currentPreflightSha256,
                currentPreflight,
                tmpDir
            );

            assert.equal(mismatchedSummary?.status, 'UNAVAILABLE');
        });

        it('surfaces task-mode workflow-config authorization in audit and closeout output', () => {
            const plannedChangedFiles = ['garda-agent-orchestrator/live/config/workflow-config.json'];
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: plannedChangedFiles,
                metrics: { changed_lines_total: 3 },
                required_reviews: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                task_id: TASK_ID,
                orchestrator_work: true,
                workflow_config_work: true,
                planned_changed_files: plannedChangedFiles,
                requested_depth: 2,
                effective_depth: 2,
                active_profile: 'standard'
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            writeIntegrityEventSequence(eventsDir, TASK_ID, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'IMPLEMENTATION_STARTED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.implementation_summary.orchestrator_work, true);
            assert.equal(result.final_closeout.implementation_summary.workflow_config_work, true);
            assert.deepEqual(result.final_closeout.implementation_summary.planned_changed_files, plannedChangedFiles);
            assert.deepEqual(
                result.final_closeout.implementation_summary.domain_scope_fingerprints?.domains.config.changed_files,
                plannedChangedFiles
            );

            const expectedLine =
                'orchestrator_work=true; workflow_config_work=true; ' +
                'planned_changed_files=garda-agent-orchestrator/live/config/workflow-config.json';
            assert.ok(formatTaskAuditSummaryText(result).includes(`TaskModeAuthorization: ${expectedLine}`));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(`Task-mode authorization: ${expectedLine}.`));
        });

        it('surfaces reviewer timing provenance only in operator audit output', () => {
            const taskId = 'T-AUDIT-TIMING';
            writeWorkflowConfig(tmpDir, false);
            writePreflight(reviewsDir, taskId, {
                mode: 'FULL_PATH',
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, taskId, '-doc-impact.json', {
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                decision: 'NO_DOC_UPDATES'
            });
            const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${taskId}-preflight.json`));
            const reviewerIdentity = 'agent:code-reviewer';
            const fixture = writeCurrentIndependentReviewFixture({
                reviewsDir,
                taskId,
                preflightSha256,
                reviewerIdentity,
                provenance: null
            });
            const timing = {
                launch_prepared_at_utc: '2026-04-29T00:00:06.000Z',
                launched_at_utc: '2026-04-29T00:00:07.000Z',
                launch_completed_at_utc: '2026-04-29T00:00:42.000Z',
                invocation_attested_at_utc: '2026-04-29T00:00:43.000Z',
                review_result_recorded_at_utc: '2026-04-29T00:01:00.000Z',
                review_output_source_mtime_utc: '2026-04-29T00:01:01.000Z'
            };
            const events = writeIntegrityEventSequence(eventsDir, taskId, [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'RULE_PACK_LOADED' },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
                { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
                { event_type: 'PREFLIGHT_CLASSIFIED' },
                { event_type: 'COMPILE_GATE_PASSED' },
                { event_type: 'REVIEW_PHASE_STARTED' },
                {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    details: {
                        task_id: taskId,
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: reviewerIdentity,
                        review_context_sha256: fixture.reviewContextSha256,
                        routing_event_sha256: 'd'.repeat(64),
                        execution_provider: 'GitHubCopilot',
                        provider: 'Claude',
                        reviewer_launch_tool: 'Codex',
                        provider_invocation_id: 'codex-subagent-run-123',
                        reviewer_launch_attestation_source: 'codex_subagent',
                        ...timing
                    }
                },
                { event_type: 'REVIEW_GATE_PASSED' },
                { event_type: 'DOC_IMPACT_ASSESSED' },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            const invocationEvent = events.find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
            assert.ok(invocationEvent);
            const invocationIntegrity = invocationEvent.integrity as Record<string, unknown>;
            const reviewPath = path.join(reviewsDir, `${taskId}-code.md`);
            const receiptPath = path.join(reviewsDir, `${taskId}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            receipt.recorded_at_utc = timing.review_result_recorded_at_utc;
            receipt.review_result_recorded_at_utc = timing.review_result_recorded_at_utc;
            receipt.review_output_source_mtime_utc = timing.review_output_source_mtime_utc;
            receipt.review_output_path = reviewPath;
            receipt.review_output_sha256 = computeFileSha256(reviewPath);
            receipt.reviewer_provenance = {
                schema_version: 1,
                attestation_type: 'reviewer_invocation_attestation',
                controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                task_sequence: invocationIntegrity.task_sequence,
                prev_event_sha256: invocationIntegrity.prev_event_sha256,
                event_sha256: invocationIntegrity.event_sha256,
                task_id: taskId,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fixture.reviewContextSha256,
                routing_event_sha256: 'd'.repeat(64),
                launch_prepared_at_utc: timing.launch_prepared_at_utc,
                launched_at_utc: timing.launched_at_utc,
                launch_completed_at_utc: timing.launch_completed_at_utc,
                invocation_attested_at_utc: timing.invocation_attested_at_utc
            };
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

            const result = buildTaskAuditSummary({
                taskId,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_timing_audit?.entries.length, 1);
            const [entry] = result.final_closeout.review_timing_audit?.entries || [];
            assert.ok(entry);
            assert.equal(entry.review_type, 'code');
            assert.equal(entry.provider, 'GitHubCopilot');
            assert.equal(entry.provider_invocation_id, 'codex-subagent-run-123');
            assert.equal(entry.launch_to_result_ms, 53000);
            assert.equal(entry.launch_to_source_mtime_ms, 54000);
            assert.equal(entry.hidden_timing_status, 'TRUSTED');
            assert.equal(entry.hidden_timing_distrust_code, null);
            const rendered = formatTaskAuditSummaryText(result);
            assert.ok(rendered.includes('Review timing audit: code(TRUSTED, launch_to_result=53000ms'));
            assert.ok(rendered.includes('provider=GitHubCopilot provider_invocation=codex-subagent-run-123'));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes('Review timing audit: code(TRUSTED'));
        });
    });
});
