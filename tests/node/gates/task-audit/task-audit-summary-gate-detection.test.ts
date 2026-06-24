import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    buildTaskAuditSummary,
    writeEvent,
    writePreflight,
    writeWorkflowConfig,
    writeActiveCompletionLock,
    makeTempDir} from './task-audit-summary-fixtures';


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
        it('marks final report contract as NOT_READY before completion passes cleanly', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: false }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.final_report_contract.blocker?.includes('Completion gate has not passed'));
        });

        it('returns BLOCKED when a gate has FAIL outcome', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.ok(result.blockers.some(b => b.gate === 'compile-gate'));
        });

        it('detects REVIEW_GATE_PASSED as required-reviews-check pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
        });

        it('detects REVIEW_GATE_PASSED_WITH_OVERRIDE as pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed with override.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
        });

        it('detects DOC_IMPACT_ASSESSED as doc-impact-gate pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const docGate = result.gates.find(g => g.gate === 'doc-impact-gate');
            assert.ok(docGate);
            assert.equal(docGate.status, 'PASS');
        });

        it('detects REVIEW_GATE_FAILED as required-reviews-check failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Review gate failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'required-reviews-check'));
        });

        it('detects RULE_PACK_LOAD_FAILED as load-rule-pack failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOAD_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Rule pack load failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const rulePackGate = result.gates.find(g => g.gate === 'load-rule-pack');
            assert.ok(rulePackGate);
            assert.equal(rulePackGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'load-rule-pack'));
        });

        it('detects PREFLIGHT_FAILED as classify-change failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Preflight failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const classifyGate = result.gates.find(g => g.gate === 'classify-change');
            assert.ok(classifyGate);
            assert.equal(classifyGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'classify-change'));
        });

        it('detects DOC_IMPACT_ASSESSMENT_FAILED as doc-impact-gate failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSMENT_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Doc impact assessment failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const docGate = result.gates.find(g => g.gate === 'doc-impact-gate');
            assert.ok(docGate);
            assert.equal(docGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'doc-impact-gate'));
        });

        it('detects COMPLETION_GATE_FAILED as completion-gate failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Completion gate failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const completionGate = result.gates.find(g => g.gate === 'completion-gate');
            assert.ok(completionGate);
            assert.equal(completionGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'completion-gate'));
        });

        it('reports INCOMPLETE point-in-time snapshot when completion finalization is still in flight', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Older completion gate failed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.equal(result.point_in_time_snapshot.gate, 'completion-gate');
            assert.equal(result.point_in_time_snapshot.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(result.blockers.find((entry) => entry.gate === 'completion-gate'), undefined);
            assert.match(result.final_report_contract.blocker || '', /point-in-time snapshot/i);
            assert.match(result.final_report_contract.blocker || '', /Re-run task-audit-summary sequentially/i);
        });

        it('keeps BLOCKED when non-completion blockers remain during in-flight finalization', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Completion gate failed.'
            });
            writeActiveCompletionLock(reviewsDir, TASK_ID);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.ok(result.blockers.some((entry) => entry.gate === 'code-review'));
        });

        it('degrades an older completion pass to INCOMPLETE while finalization remains in flight', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older completion gate passed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.equal(result.point_in_time_snapshot.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(result.point_in_time_snapshot.owner_pid, process.pid);
            assert.equal(result.point_in_time_snapshot.owner_metadata_status, 'ok');
            assert.equal(result.point_in_time_snapshot.acquisition_policy?.timeout_ms, 5000);
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.match(result.final_report_contract.blocker || '', /point-in-time snapshot/i);
        });

        it('treats stale finalization lock metadata as a point-in-time snapshot for an older completion pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older completion gate passed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);
            fs.rmSync(path.join(lockPath, 'owner.json'), { force: true });
            const staleTime = new Date(Date.now() - 60_000);
            fs.utimesSync(lockPath, staleTime, staleTime);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.match(result.point_in_time_snapshot.message || '', /Completion finalization lock is stale/i);
            assert.equal(result.point_in_time_snapshot.owner_metadata_status, 'missing');
            assert.equal(result.point_in_time_snapshot.stale_reason, 'owner_dead');
            assert.match(result.final_report_contract.blocker || '', /doctor --cleanup-stale-locks does not reclaim completion finalization locks/i);
        });

        it('handles missing events file gracefully', () => {
            // No events file created at all
            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.events_count, 0);
            assert.equal(result.integrity_status, 'MISSING');
            assert.equal(result.status, 'INCOMPLETE');
        });

        it('handles malformed JSON in events file', () => {
            const eventsFile = path.join(eventsDir, `${TASK_ID}.jsonl`);
            fs.writeFileSync(eventsFile, 'not valid json\n{"valid":true}\n{broken\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            // Should parse the one valid line
            assert.equal(result.events_count, 1);
        });

        it('handles malformed preflight JSON gracefully', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            fs.writeFileSync(
                path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                'not valid json',
                'utf8'
            );

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.changed_files, []);
            assert.equal(result.changed_files_count, 0);
        });

        it('detects HANDSHAKE_DIAGNOSTICS_RECORDED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'handshake-diagnostics');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects SHELL_SMOKE_PREFLIGHT_RECORDED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'shell-smoke-preflight');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects PREFLIGHT_CLASSIFIED as classify-change pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'classify-change');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects REVIEW_PHASE_STARTED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'INFO',
                actor: 'gate',
                message: 'Review phase started.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'review-phase');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('uses latest event when both pass and fail exist for a gate', () => {
            const early = '2026-01-01T00:00:00.000Z';
            const late = '2026-01-01T00:01:00.000Z';

            // Early pass, later fail
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: early,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: late,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed on rerun.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const compileGate = result.gates.find(g => g.gate === 'compile-gate');
            assert.ok(compileGate);
            assert.equal(compileGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'compile-gate'));
        });

        it('uses latest pass when fail precedes pass', () => {
            const early = '2026-01-01T00:00:00.000Z';
            const late = '2026-01-01T00:01:00.000Z';

            // Early fail, later pass (successful rerun)
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: early,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: late,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile passed on rerun.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const compileGate = result.gates.find(g => g.gate === 'compile-gate');
            assert.ok(compileGate);
            assert.equal(compileGate.status, 'PASS');
            assert.ok(!result.blockers.some(b => b.gate === 'compile-gate'));
        });
    });
});
