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
        it('adds blocker for missing required review artifact', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.ok(result.blockers.length > 0);
            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker);
            assert.ok(codeBlocker.reason.includes('code'));
        });

        it('no blocker when review receipt exists with schema v2 shape', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            const crypto = require('node:crypto');
            const reviewHash = crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: reviewHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.equal(codeBlocker, undefined);
        });

        it('reports blocker when review markdown exists but receipt is missing', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find((b) => b.gate === 'code-review');
            assert.ok(codeBlocker);
            assert.ok(codeBlocker.reason.includes('receipt'));
        });

    describe('integrity failure blocking', () => {
        it('reports BLOCKED when integrity_status is FAILED despite completion gate pass', () => {
            // Write events with a COMPLETION_GATE_PASSED but corrupt the integrity
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                integrity: { schema_version: 1, task_sequence: 0, prev_event_sha256: 'x', event_sha256: 'y' }
            });
            // Write a second event with a deliberately broken chain
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'STATUS_CHANGED',
                outcome: 'INFO',
                integrity: { schema_version: 1, task_sequence: 1, prev_event_sha256: 'WRONG', event_sha256: 'z' }
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.integrity_status, 'FAILED');
            assert.equal(result.status, 'BLOCKED');
            const intBlocker = result.blockers.find(b => b.gate === 'integrity');
            assert.ok(intBlocker, 'should have integrity blocker');
            assert.ok(intBlocker.reason.includes('FAILED'));
        });
    });

    describe('receipt integrity validation', () => {
        it('reports blocker when receipt task_id does not match', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: 'T-OTHER',
                review_type: 'code',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: null,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker, 'should have code-review blocker for mismatched task_id');
            assert.ok(codeBlocker.reason.includes('different task'));
        });

        it('reports blocker when receipt review_type does not match', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true, db: false, security: false, refactor: false }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'security',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: null,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker, 'should have code-review blocker for mismatched review_type');
            assert.ok(codeBlocker.reason.includes('mismatched review type'));
        });

        it('no blocker for valid schema v2 receipt with matching integrity', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { test: true }
            });
            const reviewContent = '# Test Review\nTEST REVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-test.md', reviewContent);
            const crypto = require('node:crypto');
            const reviewHash = crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex');
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: reviewHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const testBlocker = result.blockers.find(b => b.gate === 'test-review');
            assert.equal(testBlocker, undefined);
        });

        it('reports blocker when receipt artifact hash does not match review file', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED - modified after receipt');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: 'stale_hash_that_does_not_match',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker, 'should reject receipt with stale artifact hash');
            assert.ok(codeBlocker.reason.includes('modified after receipt'));
        });

        it('reports blocker when receipt JSON is malformed', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            fs.writeFileSync(
                path.join(reviewsDir, `${TASK_ID}-code-receipt.json`),
                '{broken json',
                'utf8'
            );

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker, 'should blocker when receipt is malformed');
            assert.ok(codeBlocker.reason.includes('malformed'));
        });

        it('reports blocker when receipt exists but review markdown is missing', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: null,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker, 'should block when review markdown is missing despite receipt');
            assert.ok(codeBlocker.reason.includes('review markdown not found'));
        });

        it('no blocker when schema v2 receipt has no artifact hash (hash not recorded)', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: null,
                scope_sha256: null,
                review_context_sha256: null,
                review_artifact_sha256: null,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.equal(codeBlocker, undefined, 'should not block when hash is null (not recorded)');
        });
    });
});
});
