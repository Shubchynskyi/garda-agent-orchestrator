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

            const expectedLine =
                'orchestrator_work=true; workflow_config_work=true; ' +
                'planned_changed_files=garda-agent-orchestrator/live/config/workflow-config.json';
            assert.ok(formatTaskAuditSummaryText(result).includes(`TaskModeAuthorization: ${expectedLine}`));
            assert.ok(formatFinalCloseoutMarkdown(result.final_closeout).includes(`Task-mode authorization: ${expectedLine}.`));
        });
    });
});
