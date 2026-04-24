import { spawn } from 'node:child_process';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    type TaskAuditSummaryResult
} from '../../../src/gates/task-audit-summary';
import { readReviewTrustSummary } from '../../../src/gates/task-audit-summary-collectors';
import {
    inspectCompletionGateFinalizationLock,
    scanCompletionGateFinalizationLocks,
    withCompletionGateFinalizationLockAsync
} from '../../../src/gates/finalization-lock';
import { ensureSkillsHeadlinesCurrent } from '../../../src/runtime/skill-headlines';

const NODE_BACKEND_SKILL_SOURCE = path.join(
    process.cwd(),
    'template',
    'skill-packs',
    'node-backend',
    'skills',
    'node-backend'
);

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'task-audit-test-'));
}

function writeEvent(eventsDir: string, taskId: string, event: Record<string, unknown>): void {
    const file = path.join(eventsDir, `${taskId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
}

function writePreflight(reviewsDir: string, taskId: string, data: Record<string, unknown>): void {
    const payload = {
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        ...data
    };
    if (Object.prototype.hasOwnProperty.call(data, 'review_execution_policy') && data.review_execution_policy === undefined) {
        delete (payload as Record<string, unknown>).review_execution_policy;
    }
    fs.writeFileSync(
        path.join(reviewsDir, `${taskId}-preflight.json`),
        JSON.stringify(payload),
        'utf8'
    );
}

function writeArtifact(reviewsDir: string, taskId: string, suffix: string, data: unknown): void {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    fs.writeFileSync(path.join(reviewsDir, `${taskId}${suffix}`), content, 'utf8');
}

function computeFileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function computeTaskTextSha256(taskText: string): string {
    return createHash('sha256').update(taskText.trim(), 'utf8').digest('hex');
}

function writeActiveCompletionLock(reviewsDir: string, taskId: string): string {
    const lockPath = path.join(reviewsDir, `${taskId}-completion-gate.lock`);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
    return lockPath;
}

function writeWorkflowConfig(
    repoRoot: string,
    enabled: boolean,
    reviewExecutionPolicyMode: 'parallel_all' | 'test_after_code' | 'code_first_optional' | 'strict_sequential' = 'code_first_optional'
): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled,
                command: 'npm test'
            },
            review_execution_policy: {
                mode: reviewExecutionPolicyMode
            }
        }, null, 2),
        'utf8'
    );
}

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

            const codeBlocker = result.blockers.find(b => b.gate === 'code-review');
            assert.ok(codeBlocker);
            assert.ok(codeBlocker.reason.includes('receipt'));
        });

        it('detects evidence artifacts', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', { status: 'PASS' });
            writeArtifact(reviewsDir, TASK_ID, '-preflight.json', {
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

            const taskModeEvidence = result.evidence.find(e => e.kind === 'task-mode');
            assert.ok(taskModeEvidence);
            assert.equal(taskModeEvidence.exists, true);
            assert.ok(taskModeEvidence.sha256);

            const compileEvidence = result.evidence.find(e => e.kind === 'compile-gate');
            assert.ok(compileEvidence);
            assert.equal(compileEvidence.exists, false);
            assert.equal(compileEvidence.sha256, null);
        });

        it('returns INCOMPLETE when completion gate is present but supporting lifecycle evidence is missing', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
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

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.final_report_contract.blocker?.includes('supporting lifecycle evidence is incomplete'));
        });

        it('keeps historical completed tasks green when live full-suite validation is enabled later', () => {
            const now = new Date().toISOString();
            writeWorkflowConfig(tmpDir, true);
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
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

            assert.equal(result.status, 'PASS');
            assert.equal(result.final_report_contract.status, 'READY');
            assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), false);
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'full-suite-validation'), false);
        });

        it('treats downstream gate passes as stale after a newer compile cycle begins', () => {
            const compileOne = '2026-01-01T00:00:01.000Z';
            const reviewPhase = '2026-01-01T00:00:02.000Z';
            const reviewGate = '2026-01-01T00:00:03.000Z';
            const docImpact = '2026-01-01T00:00:04.000Z';
            const completion = '2026-01-01T00:00:05.000Z';
            const compileTwo = '2026-01-01T00:00:06.000Z';

            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: compileOne,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: reviewPhase,
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review phase started for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: reviewGate,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: docImpact,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact recorded for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: completion,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed for the earlier cycle.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: compileTwo,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the earlier completion.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: compileTwo,
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                preflight_hash_sha256: 'current-cycle'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.equal(result.gates.find((gate) => gate.gate === 'compile-gate')?.status, 'PASS');
            assert.equal(result.gates.find((gate) => gate.gate === 'required-reviews-check')?.status, 'MISSING');
            assert.equal(result.gates.find((gate) => gate.gate === 'doc-impact-gate')?.status, 'MISSING');
            assert.equal(result.gates.find((gate) => gate.gate === 'completion-gate')?.status, 'MISSING');
            assert.ok(result.final_report_contract.blocker);
        });

        it('does not let stale required-review receipts block a freshly recompiled cycle', () => {
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: 'stale-hash',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:06.000Z',
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                task_id: TASK_ID,
                event_type: 'REVIEW_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical review was recorded for the earlier cycle.',
                details: {
                    review_type: 'code',
                    review_context_path: path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:03.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Historical completion gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:06.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the stale review artifacts were left behind.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.gates.find((gate) => gate.gate === 'required-reviews-check')?.status, 'MISSING');
            assert.equal(result.blockers.find((blocker) => blocker.gate === 'code-review'), undefined);
        });

        it('keeps skipped full-suite evidence non-blocking when the task-bound cycle disabled the mode', () => {
            const now = new Date().toISOString();
            writeWorkflowConfig(tmpDir, false);
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation skipped because the mode is disabled.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
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

            assert.equal(result.status, 'PASS');
            assert.equal(result.final_report_contract.status, 'READY');
            assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), false);
            assert.equal(result.blockers.some((blocker) => blocker.gate === 'full-suite-validation'), false);
            assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: false');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'code_first_optional');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: code_first_optional');
        });

        it('requires full-suite again when an older skipped event is followed by a newer compile cycle', () => {
            writeWorkflowConfig(tmpDir, true);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:02.400Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older cycle skipped full-suite while the mode was disabled.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'A newer compile cycle started after the skipped event.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'current-cycle'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find((gate) => gate.gate === 'full-suite-validation')?.status, 'MISSING');
            assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: true');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'code_first_optional');
        });

        it('keeps legacy compatibility mode for pre-T-147 preflight artifacts even when live config changed later', () => {
            writeWorkflowConfig(tmpDir, false, 'strict_sequential');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: undefined
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'legacy_test_downstream');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: legacy_test_downstream (implicit compatibility mode)');
            assert.ok(renderedSummaryText.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
            assert.ok(renderedMarkdown.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
            assert.ok(!renderedSummaryText.includes('Review execution policy: strict_sequential'));
            assert.ok(!renderedMarkdown.includes('Review execution policy: strict_sequential'));
        });

        it('surfaces the effective review execution policy in current-cycle audit output', () => {
            writeWorkflowConfig(tmpDir, false, 'strict_sequential');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: {
                    mode: 'strict_sequential'
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'strict_sequential');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
            assert.ok(renderedSummaryText.includes('Review execution policy: strict_sequential'));
            assert.ok(renderedMarkdown.includes('Review execution policy: strict_sequential'));
        });

        it('recovers the current-cycle review execution policy from timeline evidence when the preflight artifact is gone', () => {
            writeWorkflowConfig(tmpDir, false, 'parallel_all');
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {},
                review_execution_policy: {
                    mode: 'strict_sequential'
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'cycle-preflight'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.500Z',
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'INFO',
                actor: 'gate',
                message: 'Preflight completed with mode FULL_PATH.',
                details: {
                    output_path: preflightPath.replace(/\\/g, '/'),
                    review_execution_policy: {
                        mode: 'strict_sequential'
                    }
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:01.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'cycle-preflight'
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            fs.rmSync(preflightPath, { force: true });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.workflow?.review_execution_policy_mode, 'strict_sequential');
            assert.equal(result.final_closeout.workflow?.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
        });

        it('prefers the latest full-suite terminal event over older skipped evidence from a previous cycle', () => {
            writeWorkflowConfig(tmpDir, false);
            const laterTerminalEvents = [
                { taskId: 'T-201', eventType: 'FULL_SUITE_VALIDATION_PASSED', outcome: 'PASS' },
                { taskId: 'T-202', eventType: 'FULL_SUITE_VALIDATION_WARNED', outcome: 'PASS' },
                { taskId: 'T-203', eventType: 'FULL_SUITE_VALIDATION_FAILED', outcome: 'FAIL' }
            ] as const;

            for (const [index, laterTerminalEvent] of laterTerminalEvents.entries()) {
                const now = Date.parse('2026-01-01T00:00:00.000Z') + (index * 1000);
                writeEvent(eventsDir, laterTerminalEvent.taskId, {
                    timestamp_utc: new Date(now).toISOString(),
                    task_id: laterTerminalEvent.taskId,
                    event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full-suite validation skipped because the mode is disabled.'
                });
                writeEvent(eventsDir, laterTerminalEvent.taskId, {
                    timestamp_utc: new Date(now + 1).toISOString(),
                    task_id: laterTerminalEvent.taskId,
                    event_type: laterTerminalEvent.eventType,
                    outcome: laterTerminalEvent.outcome,
                    actor: 'gate',
                    message: `Later cycle emitted ${laterTerminalEvent.eventType}.`
                });
                writePreflight(reviewsDir, laterTerminalEvent.taskId, {
                    changed_files: [],
                    metrics: { changed_lines_total: 0 },
                    required_reviews: {}
                });

                const result = buildTaskAuditSummary({
                    taskId: laterTerminalEvent.taskId,
                    repoRoot: tmpDir,
                    eventsRoot: eventsDir,
                    reviewsRoot: reviewsDir
                });

                assert.equal(result.final_closeout.workflow?.visible_summary_line, 'Mandatory full-suite: true');
                assert.equal(result.gates.some((gate) => gate.gate === 'full-suite-validation'), true);
            }
        });

        it('keeps current-cycle full-suite gate evidence when the compile artifact timestamp trails the compile event', () => {
            writeWorkflowConfig(tmpDir, true);
            const preflightPath = path.join(reviewsDir, `${TASK_ID}-preflight.json`);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });
            writeArtifact(reviewsDir, TASK_ID, '-compile-gate.json', {
                timestamp_utc: '2026-01-01T00:00:00.400Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed for the current cycle.',
                details: {
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_hash_sha256: 'current-cycle'
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: '2026-01-01T00:00:02.000Z',
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation passed for the current cycle.',
                details: {
                    cycle_binding: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_sha256: 'current-cycle',
                        compile_gate_timestamp: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.gates.find((gate) => gate.gate === 'compile-gate')?.status, 'PASS');
            assert.equal(result.gates.find((gate) => gate.gate === 'full-suite-validation')?.status, 'PASS');
        });

        it('builds a canonical final closeout payload from task-mode, review-gate, doc-impact, and token-economy evidence', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 6000).toISOString(),
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 5000).toISOString(),
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 4000).toISOString(),
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 3000).toISOString(),
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 2000).toISOString(),
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.',
                details: {
                    output_telemetry: {
                        estimated_saved_chars: 62,
                        estimated_saved_tokens: 62,
                        raw_char_count: 248,
                        filtered_char_count: 186,
                        raw_token_count_estimate: 180,
                        filtered_token_count_estimate: 118
                    }
                }
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 250).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review phase started.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 500).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 750).toISOString(),
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) + 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                requested_depth: 2,
                effective_depth: 2,
                active_profile: 'balanced'
            });
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 42 },
                required_reviews: { code: true, test: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', {
                verdicts: {
                    code: 'REVIEW PASSED',
                    test: 'TEST REVIEW PASSED'
                }
            });
            const crypto = require('node:crypto');
            const codeReviewContent = '# Code Review\nREVIEW PASSED';
            const testReviewContent = '# Test Review\nTEST REVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-review-context.json', {
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codeReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(codeReviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                trust_level: 'LOCAL_ASSERTED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-test-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(testReviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'direct Codex provider_entrypoint cannot supply attested reviewer launch evidence',
                trust_level: 'LOCAL_ASSERTED'
            });
            writeArtifact(reviewsDir, TASK_ID, '-doc-impact.json', {
                decision: 'DOCS_UPDATED',
                behavior_changed: false,
                changelog_updated: false,
                docs_updated: ['docs/cli-reference.md']
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.status, 'READY');
            assert.equal(result.final_closeout.artifact_state, 'PENDING');
            assert.equal(result.final_closeout.implementation_summary.requested_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.effective_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.path_mode, 'FULL_PATH');
            assert.deepEqual(result.final_closeout.implementation_summary.review_verdicts, {
                code: 'REVIEW PASSED',
                test: 'TEST REVIEW PASSED'
            });
            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.ok(result.final_closeout.review_trust?.visible_summary_line?.includes('incomplete or invalid'));
            assert.ok(result.final_closeout.review_trust?.policy_summary_line?.includes('asserted local review may finish this'));
            assert.equal(result.final_closeout.implementation_summary.docs_updated, true);
            assert.deepEqual(result.final_closeout.docs.docs_updated, ['docs/cli-reference.md']);
            assert.ok(result.final_closeout.token_economy?.visible_summary_line?.includes('Suppressed output: ~62 chars'));
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, false);
        });

        it('includes full-suite validation telemetry in final closeout token economy', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'FULL_SUITE_VALIDATION_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Full-suite validation passed.',
                details: {
                    output_telemetry: {
                        estimated_saved_chars: 420,
                        estimated_saved_tokens: 105,
                        raw_char_count: 600,
                        filtered_char_count: 180,
                        raw_token_count_estimate: 150,
                        filtered_token_count_estimate: 45
                    }
                }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.token_economy?.total_estimated_saved_chars, 420);
            assert.equal(result.final_closeout.token_economy?.total_estimated_saved_tokens, 105);
            assert.ok(result.final_closeout.token_economy?.visible_summary_line?.includes('full-suite validation output ~420 chars'));
        });

        it('keeps the legacy trust summary visible when preflight review metadata is missing but historical review artifacts remain', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_provenance: {
                    schema_version: 1,
                    attestation_type: 'controller_event_integrity',
                    controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                    task_sequence: 1,
                    prev_event_sha256: null,
                    event_sha256: 'a'.repeat(64)
                },
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'LEGACY_LOCAL_AUDITED_CLAIM');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /legacy LOCAL_AUDITED claim/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: legacy LOCAL_AUDITED claim/i);
        });

        it('keeps an unavailable trust summary visible when only a partial compatibility review artifact remains', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /incomplete or invalid/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: unavailable/i);
        });

        it('degrades review trust summary when required review trust evidence is incomplete or invalid', () => {
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                reviewer_provenance: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'INDEPENDENT_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true, test: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review artifact no longer matches the receipt hash', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: crypto.createHash('sha256').update('# Code Review\nREVIEW PASSED - stale', 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps current-cycle trust unavailable when a required review receipt omits review_artifact_sha256', () => {
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: null,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the receipt preflight hash no longer matches the current preflight', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: 'stale-preflight-hash',
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback receipt omits reviewer_fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent receipt uses a self-scoped reviewer identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps trust unavailable when REVIEW_RECORDED telemetry points to a deprecated same_agent_fallback context at a noncanonical path', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            const customReviewContextPath = path.join(reviewsDir, 'custom-code-review-context.json');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            fs.writeFileSync(customReviewContextPath, JSON.stringify({
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            }, null, 2) + '\n', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(customReviewContextPath),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                { code: customReviewContextPath }
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review context routing diverges from the receipt', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback routing conflicts with a delegation-required policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'delegation_required',
                    delegation_required: true,
                    expected_execution_mode: 'delegated_subagent',
                    fallback_allowed: false,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent routing conflicts with a same-agent-only policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback uses a non-self-scoped routing identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: 'provider limitation'
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback review-context omits fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps same_agent_fallback review-context unavailable even when legacy policy marked fallback_reason optional', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('infers a conventional-style commit suggestion from task metadata and changed scope', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | ux/conventional-commit-suggestion | Make the final agent report suggest conventional-style commit messages by default | gpt-5.4 | 2026-04-15 | balanced | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: [
                    'src/gates/task-audit-summary.ts',
                    'template/docs/agent-rules/80-task-workflow.md'
                ],
                metrics: { changed_lines_total: 42 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_template, 'git commit -m "<type>(<scope>): <summary>"');
            assert.equal(result.final_report_contract.commit_command_suggestion, 'git commit -m "fix(orchestration): conventional commit suggestion"');
            assert.equal(result.final_report_contract.required_order[1], 'git commit -m "fix(orchestration): conventional commit suggestion"');
        });

        it('keeps task metadata inference working when TASK.md notes cell is empty', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | reliability/review-context-canonicalization | Unify review-context artifact naming and make all review gates use one canonical path family | gpt-5.4 | 2026-04-15 | strict | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_suggestion, 'git commit -m "fix(orchestration): review context canonicalization"');
        });

        it('keeps scope inference deterministic when changed_files order differs', () => {
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '# TASK.md',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-AUDIT-1 | 🟩 DONE | P2 | reliability/deterministic-commit-scope | Keep final report commit scope deterministic | gpt-5.4 | 2026-04-15 | balanced | |'
            ].join('\n'), 'utf8');
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/validators/verify.ts', 'src/materialization/init.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });
            const first = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/materialization/init.ts', 'src/validators/verify.ts'],
                metrics: { changed_lines_total: 18 },
                required_reviews: {}
            });
            const second = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(first.final_report_contract.commit_command_suggestion, second.final_report_contract.commit_command_suggestion);
            assert.equal(first.final_report_contract.commit_command_suggestion, 'git commit -m "fix(materialization): deterministic commit scope"');
        });

        it('falls back to the conventional commit template when task metadata is unavailable', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 8 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.commit_command_template, 'git commit -m "<type>(<scope>): <summary>"');
            assert.equal(result.final_report_contract.commit_command_suggestion, 'git commit -m "<type>(<scope>): <summary>"');
            assert.equal(result.final_report_contract.required_order[1], 'git commit -m "<type>(<scope>): <summary>"');
        });

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

    describe('final closeout materialization', () => {
        it('writes canonical final closeout json and markdown artifacts for PASS summaries', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 7000).toISOString(),
                task_id: TASK_ID,
                event_type: 'TASK_MODE_ENTERED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Task mode entered.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 6000).toISOString(),
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOADED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Rule pack loaded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 5000).toISOString(),
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 4000).toISOString(),
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 3000).toISOString(),
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 2000).toISOString(),
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 1000).toISOString(),
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: new Date(Date.parse(now) - 500).toISOString(),
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Completion gate passed.'
            });
            writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                requested_depth: 2,
                effective_depth: 2
            });
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/example.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            synchronizeFinalCloseoutArtifacts(result);

            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            const renderedMarkdown = formatFinalCloseoutMarkdown(result.final_closeout);
            const renderedSummaryText = formatTaskAuditSummaryText(result);
            assert.equal(fs.existsSync(jsonPath), true);
            assert.equal(fs.existsSync(markdownPath), true);
            assert.equal(result.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
            const closeoutJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            assert.equal(closeoutJson.artifact_state, 'MATERIALIZED');
            assert.equal(closeoutJson.workflow.visible_summary_line, 'Mandatory full-suite: false');
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Suggested commit command:'));
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Mandatory full-suite: false'));
            assert.ok(renderedSummaryText.includes('Mandatory full-suite: false'));
            assert.ok(renderedMarkdown.includes('Do you want me to commit now? (yes/no)'));
        });

        it('renders the mandatory full-suite summary line when present', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                review_trust: {
                    status: 'ASSERTED_LOCAL_ONLY',
                    trust_levels: ['LOCAL_ASSERTED'],
                    execution_modes: ['DELEGATED_SUBAGENT'],
                    independent_review_attested: false,
                    completion_policy: 'ASSERTED_LOCAL_ALLOWED',
                    visible_summary_line: 'Review trust: LOCAL_ASSERTED via DELEGATED_SUBAGENT; not independent audited review.',
                    policy_summary_line: 'Review policy: asserted local review may finish this code task; independent audited review requires separate attestation or human sign-off.'
                },
                workflow: {
                    mandatory_full_suite_enabled: true,
                    visible_summary_line: 'Mandatory full-suite: true'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): full-suite toggle"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Mandatory full-suite: true'));
            assert.ok(renderedMarkdown.includes('Review trust: LOCAL_ASSERTED via DELEGATED_SUBAGENT; not independent audited review.'));
            assert.ok(renderedMarkdown.includes('Review policy: asserted local review may finish this code task; independent audited review requires separate attestation or human sign-off.'));
        });

        it('renders the localized compact agent report block when closeout carries agent report state', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-168-final-closeout.json',
                    markdown: 'runtime/reviews/T-168-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 15,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'generic_context_sufficient',
                    visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'Russian',
                    assistant_language_confirmed: true,
                    next_task_command: 'Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.',
                    latest_update_notice: '1.2.3'
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): localized report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Итог задачи'));
            assert.ok(renderedMarkdown.includes('Язык: Russian (нормализован)'));
            assert.ok(renderedMarkdown.includes('Профиль: balanced'));
            assert.ok(renderedMarkdown.includes('Обязательный full-suite: выключен'));
            assert.ok(renderedMarkdown.includes('Скажите агенту: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('renders the compact agent report block in French when closeout language is French', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 15,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'generic_context_sufficient',
                    visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                },
                workflow: {
                    mandatory_full_suite_enabled: true,
                    visible_summary_line: 'Mandatory full-suite: true'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'French',
                    assistant_language_confirmed: true,
                    next_task_command: 'Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.',
                    latest_update_notice: '1.2.3'
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): localized report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Cloture de la tache'));
            assert.ok(renderedMarkdown.includes('Langue: French (normalise)'));
            assert.ok(renderedMarkdown.includes('Mode de revue: aucune revue obligatoire; verdicts: code=REVIEW PASSED, test=TEST REVIEW PASSED'));
            assert.ok(renderedMarkdown.includes('Competences optionnelles: aucune competence supplementaire (generic_context_sufficient)'));
            assert.ok(renderedMarkdown.includes('Full-suite obligatoire: active'));
            assert.ok(renderedMarkdown.includes('Dites a l\'agent: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('localizes unavailable optional-skill summaries inside the compact report block', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'unavailable',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'task_events_integrity',
                    visible_summary_line: 'Optional skills: unavailable (reason: task_events_integrity)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'French',
                    assistant_language_confirmed: true,
                    next_task_command: null,
                    latest_update_notice: null
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): localized report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Competences optionnelles: indisponible (raison: task_events_integrity)'));
        });

        it('localizes none-used optional-skill summaries inside the compact report block', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'selected_installed_skills',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: null,
                    visible_summary_line: 'Optional skills: none_used (selected: node-backend, reason: task_text+paths)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'German',
                    assistant_language_confirmed: true,
                    next_task_command: null,
                    latest_update_notice: null
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): localized report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optionale Skills: nicht verwendet (ausgewaehlt: node-backend, Grund: task_text+paths)'));
        });

        it('renders the compact optional skill summary line when present', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'selected_installed_skills',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: ['node-backend'],
                    recommended_missing_pack_ids: [],
                    as_is_reason: null,
                    visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): optional skill selection"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: node-backend (reason: task_text+paths)'));
        });

        it('preserves recommended missing-pack summaries in final closeout markdown', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'required',
                    decision: 'recommended_missing_packs',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: ['node-backend'],
                    as_is_reason: 'no_relevant_installed_skill',
                    visible_summary_line: 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text+paths)'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): optional skill selection"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text+paths)'));
        });

        it('keeps historical optional-skill summaries stable when current policy or pack inventory drift later', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skills-headlines.json'),
                JSON.stringify({
                    version: 2,
                    installed_pack_ids: ['node-backend'],
                    baseline_skill_ids: [],
                    installed_optional_skill_ids: ['node-backend'],
                    custom_skill_ids: [],
                    skills: [
                        {
                            id: 'node-backend',
                            directory: 'node-backend',
                            name: 'Node Backend',
                            summary: 'Node backend helper.',
                            pack: 'node-backend',
                            source: 'installed_optional',
                            implemented: true,
                            review_binding: 'general_purpose',
                            aliases: ['node'],
                            tags: ['node', 'backend']
                        }
                    ],
                    optional_packs: [
                        {
                            id: 'node-backend',
                            label: 'Node Backend',
                            description: 'Node backend specialist pack.',
                            installed: true,
                            implemented: true,
                            collides_with_baseline: false,
                            ready_skill_ids: ['node-backend'],
                            placeholder_skill_ids: [],
                            recommended_for: ['node backend'],
                            tags: ['node', 'backend']
                        }
                    ]
                }, null, 2),
                'utf8'
            );
            const skillRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend');
            fs.mkdirSync(skillRoot, { recursive: true });
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n', 'utf8');

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'recommended_missing_packs',
                selected_installed_skills: [],
                recommended_missing_packs: [
                    {
                        id: 'node-backend',
                        label: 'Node Backend',
                        ready_skill_ids: ['node-backend'],
                        reason_codes: ['task_signals'],
                        matches: { task_signals: ['node-backend'], changed_path_signals: [] }
                    }
                ],
                as_is_reason: 'no_relevant_installed_skill',
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'headlines-hash',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.policy_mode, 'advisory');
            assert.equal(result.final_closeout.optional_skills?.decision, 'recommended_missing_packs');
            assert.deepEqual(result.final_closeout.optional_skills?.recommended_missing_pack_ids, ['node-backend']);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text)');
        });

        it('preserves as_is optional-skill summaries when the artifact still matches the current TASK.md title', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | api | Implement request validation for a Node.js API endpoint | unassigned | 2026-04-20 | default | fixture |`
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'as_is',
                selected_installed_skills: [],
                recommended_missing_packs: [],
                as_is_reason: 'generic_context_sufficient',
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'as_is');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.as_is_reason, 'generic_context_sufficient');
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: as_is (reason: generic_context_sufficient)');
        });

        it('invalidates optional-skill summaries when the current TASK.md title no longer matches the artifact task summary hash', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | docs | Refresh landing-page copy for the marketing site | unassigned | 2026-04-20 | default | fixture |`
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: [] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'invalidated');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: artifact_drift)');
        });

        it('invalidates optional-skill summaries when the task row disappears from TASK.md', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-04-20 | default | fixture |'
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: [] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'invalidated');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: artifact_drift)');
        });

        it('surfaces selected optional-skill summaries only when optional-skill activation telemetry confirms usage', () => {
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                [
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'SKILL_SELECTED',
                        details: {
                            skill_id: 'node-backend',
                            trigger_reason: 'optional_skill_selection'
                        }
                    }),
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:02.000Z',
                        event_type: 'SKILL_REFERENCE_LOADED',
                        details: {
                            skill_id: 'node-backend',
                            reference_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                            trigger_reason: 'optional_task_skill'
                        }
                    })
                ].join('\n'),
                'utf8'
            );
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, ['node-backend']);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: node-backend (reason: task_text+paths)');
        });

        it('does not overstate optional-skill usage when the artifact was selected but never activated', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: none_used (selected: node-backend, reason: task_text+paths)');
        });

        it('degrades optional-skill usage summary to unavailable when the task timeline is malformed', () => {
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                [
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'SKILL_SELECTED',
                        details: {
                            skill_id: 'node-backend',
                            trigger_reason: 'optional_skill_selection'
                        }
                    }),
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:02.000Z',
                        event_type: 'SKILL_REFERENCE_LOADED',
                        details: {
                            skill_id: 'node-backend',
                            reference_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                            trigger_reason: 'optional_task_skill'
                        }
                    }),
                    '{'
                ].join('\n'),
                'utf8'
            );
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'unavailable');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: task_events_integrity)');
        });

        it('removes stale final closeout artifacts when the audit summary is not ready', () => {
            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            fs.writeFileSync(jsonPath, '{}\n', 'utf8');
            fs.writeFileSync(markdownPath, 'stale\n', 'utf8');
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                mode: 'FULL_PATH',
                changed_files: ['src/example.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: {}
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            synchronizeFinalCloseoutArtifacts(result);

            assert.equal(fs.existsSync(jsonPath), false);
            assert.equal(fs.existsSync(markdownPath), false);
            assert.equal(result.final_closeout.artifact_state, 'REMOVED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, false);
        });

        it('preserves existing final closeout artifacts when an in-flight snapshot becomes stale before sync', () => {
            const jsonPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.json`);
            const markdownPath = path.join(reviewsDir, `${TASK_ID}-final-closeout.md`);
            fs.writeFileSync(jsonPath, '{}\n', 'utf8');
            fs.writeFileSync(markdownPath, 'ready\n', 'utf8');

            const summary = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });
            summary.point_in_time_snapshot = {
                status: 'FINALIZATION_IN_FLIGHT',
                gate: 'completion-gate',
                message: 'Completion gate is currently in flight.',
                recommended_action: 'Re-run task-audit-summary sequentially after completion-gate finishes.',
                lock_path: path.join(reviewsDir, `${TASK_ID}-completion-gate.lock`).replace(/\\/g, '/')
            };
            summary.final_closeout = {
                ...summary.final_closeout,
                status: 'NOT_READY',
                artifact_state: 'NOT_READY'
            };

            synchronizeFinalCloseoutArtifacts(summary);

            assert.equal(fs.existsSync(jsonPath), true);
            assert.equal(fs.existsSync(markdownPath), true);
            assert.equal(summary.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(summary.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
        });
    });

    describe('formatTaskAuditSummaryText', () => {
        it('renders compact text output', () => {
            const summary: TaskAuditSummaryResult = {
                task_id: 'T-TEST-1',
                generated_utc: '2026-01-01T00:00:00.000Z',
                status: 'INCOMPLETE',
                events_count: 3,
                first_event_utc: '2026-01-01T00:00:00.000Z',
                last_event_utc: '2026-01-01T00:01:00.000Z',
                integrity_status: 'PASS',
                gates: [
                    { gate: 'enter-task-mode', status: 'PASS', event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00.000Z' },
                    { gate: 'compile-gate', status: 'MISSING', event_type: 'COMPILE_GATE_PASSED' }
                ],
                changed_files: ['src/example.ts'],
                changed_files_count: 1,
                changed_lines_total: 50,
                required_reviews: { code: true, db: false },
                scope_category: null,
                profile_review_decisions: null,
                evidence: [
                    { kind: 'task-mode', path: 'runtime/reviews/T-TEST-1-task-mode.json', exists: true, sha256: 'abc123' },
                    { kind: 'preflight', path: 'runtime/reviews/T-TEST-1-preflight.json', exists: false, sha256: null }
                ],
                blockers: [
                    { gate: 'code-review', reason: 'Required code review artifact not found' }
                ],
                point_in_time_snapshot: {
                    status: 'FINALIZATION_IN_FLIGHT',
                    gate: 'completion-gate',
                    message: 'Completion gate is currently in flight, so this audit summary is a point-in-time snapshot and may still reflect an older completion result.',
                    recommended_action: 'Re-run task-audit-summary sequentially after completion-gate finishes.',
                    lock_path: 'runtime/reviews/T-TEST-1-completion-gate.lock'
                },
                final_report_contract: {
                    status: 'NOT_READY',
                    blocker: 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
                    required_order: [
                        'implementation summary',
                        'git commit -m "fix(orchestration): <summary>"',
                        'Do you want me to commit now? (yes/no)'
                    ],
                    implementation_summary_requirements: ['depth', 'path mode', 'review verdicts', 'docs updated'],
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                },
                final_closeout: {
                    schema_version: 1,
                    event_source: 'task-audit-summary',
                    task_id: 'T-TEST-1',
                    generated_utc: '2026-01-01T00:00:00.000Z',
                    audit_status: 'INCOMPLETE',
                    status: 'NOT_READY',
                    blocker: 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
                    artifact_state: 'NOT_READY',
                    artifact_paths: {
                        json: 'runtime/reviews/T-TEST-1-final-closeout.json',
                        markdown: 'runtime/reviews/T-TEST-1-final-closeout.md'
                    },
                    implementation_summary: {
                        requested_depth: 2,
                        effective_depth: 2,
                        path_mode: 'FULL_PATH',
                        review_verdicts: { code: 'MISSING' },
                        docs_updated: false,
                        changed_files_count: 1,
                        changed_lines_total: 50,
                        scope_category: null,
                        active_profile: null
                    },
                    optional_skills: {
                        policy_mode: 'advisory',
                        decision: 'as_is',
                        selected_skill_ids: [],
                        used_skill_ids: [],
                        recommended_missing_pack_ids: [],
                        as_is_reason: 'generic_context_sufficient',
                        visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                    },
                    docs: {
                        decision: 'NO_DOC_UPDATES',
                        behavior_changed: false,
                        changelog_updated: false,
                        docs_updated: []
                    },
                    token_economy: null,
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                }
            };

            const text = formatTaskAuditSummaryText(summary);

            assert.ok(text.includes('Task: T-TEST-1'));
            assert.ok(text.includes('Status: INCOMPLETE'));
            assert.ok(text.includes('Events: 3'));
            assert.ok(text.includes('[+] enter-task-mode'));
            assert.ok(text.includes('[ ] compile-gate'));
            assert.ok(text.includes('src/example.ts'));
            assert.ok(text.includes('RequiredReviews: code'));
            assert.ok(text.includes('[+] task-mode'));
            assert.ok(text.includes('[ ] preflight'));
            assert.ok(text.includes('Blockers:'));
            assert.ok(text.includes('code-review'));
            assert.ok(text.includes('PointInTimeSnapshot: FINALIZATION_IN_FLIGHT'));
            assert.ok(text.includes('RecommendedAction: Re-run task-audit-summary sequentially after completion-gate finishes.'));
            assert.ok(text.includes('FinalReportContract: NOT_READY'));
            assert.ok(text.includes('FinalCloseout: NOT_READY (NOT_READY)'));
            assert.ok(text.includes('Optional skills: as_is (reason: generic_context_sufficient)'));
            assert.ok(text.includes('git commit -m "fix(orchestration): <summary>"'));
        });

        it('omits blockers section when empty', () => {
            const summary: TaskAuditSummaryResult = {
                task_id: 'T-CLEAN',
                generated_utc: '2026-01-01T00:00:00.000Z',
                status: 'PASS',
                events_count: 0,
                first_event_utc: null,
                last_event_utc: null,
                integrity_status: 'PASS',
                gates: [],
                changed_files: [],
                changed_files_count: 0,
                changed_lines_total: 0,
                required_reviews: {},
                scope_category: null,
                profile_review_decisions: null,
                evidence: [],
                blockers: [],
                point_in_time_snapshot: {
                    status: 'STABLE',
                    gate: null,
                    message: null,
                    recommended_action: null,
                    lock_path: null
                },
                final_report_contract: {
                    status: 'READY',
                    blocker: null,
                    required_order: [
                        'implementation summary',
                        'git commit -m "fix(orchestration): <summary>"',
                        'Do you want me to commit now? (yes/no)'
                    ],
                    implementation_summary_requirements: ['depth', 'path mode', 'review verdicts', 'docs updated'],
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                },
                final_closeout: {
                    schema_version: 1,
                    event_source: 'task-audit-summary',
                    task_id: 'T-CLEAN',
                    generated_utc: '2026-01-01T00:00:00.000Z',
                    audit_status: 'PASS',
                    status: 'READY',
                    blocker: null,
                    artifact_state: 'MATERIALIZED',
                    artifact_paths: {
                        json: 'runtime/reviews/T-CLEAN-final-closeout.json',
                        markdown: 'runtime/reviews/T-CLEAN-final-closeout.md'
                    },
                    implementation_summary: {
                        requested_depth: 2,
                        effective_depth: 2,
                        path_mode: 'FULL_PATH',
                        review_verdicts: {},
                        docs_updated: false,
                        changed_files_count: 0,
                        changed_lines_total: 0,
                        scope_category: null,
                        active_profile: null
                    },
                    docs: {
                        decision: 'NO_DOC_UPDATES',
                        behavior_changed: false,
                        changelog_updated: false,
                        docs_updated: []
                    },
                    token_economy: null,
                    commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                    commit_command_suggestion: 'git commit -m "fix(orchestration): <summary>"',
                    commit_question: 'Do you want me to commit now? (yes/no)'
                }
            };

            const text = formatTaskAuditSummaryText(summary);

            assert.ok(!text.includes('Blockers:'));
            assert.ok(text.includes('FinalReportContract: READY'));
            assert.ok(text.includes('FinalCloseout: READY (MATERIALIZED)'));
            assert.ok(text.includes('Do you want me to commit now? (yes/no)'));
        });
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

describe('gates/finalization-lock', () => {
    it('does not throw when owner metadata is missing during lock inspection', () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const lockPath = writeActiveCompletionLock(reviewsDir, 'T-LOCK-1');
        const ownerPath = path.join(lockPath, 'owner.json');

        try {
            fs.rmSync(ownerPath, { force: true });
            const inspection = inspectCompletionGateFinalizationLock(reviewsDir, 'T-LOCK-1');
            assert.equal(inspection.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(typeof inspection.active, 'boolean');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('reports contention with timeout diagnostics when a live completion finalization lock is held elsewhere', async () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const taskId = 'T-LOCK-TIMEOUT';
        const lockPath = path.join(reviewsDir, `${taskId}-completion-gate.lock`);
        const ownerPath = path.join(lockPath, 'owner.json');
        const child = spawn(
            process.execPath,
            [
                '-e',
                [
                    'const fs = require("node:fs");',
                    'const os = require("node:os");',
                    'const path = require("node:path");',
                    'const lockPath = process.argv[1];',
                    'fs.mkdirSync(lockPath, { recursive: true });',
                    'fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({',
                    '  pid: process.pid,',
                    '  hostname: os.hostname(),',
                    '  created_at_utc: new Date().toISOString()',
                    '}), "utf8");',
                    'setTimeout(() => {}, 10000);'
                ].join(' '),
                lockPath
            ],
            { stdio: 'ignore' }
        );

        try {
            for (let attempt = 0; attempt < 20 && !fs.existsSync(ownerPath); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(fs.existsSync(ownerPath), true, 'expected helper process to materialize owner metadata');

            await assert.rejects(
                () => withCompletionGateFinalizationLockAsync(reviewsDir, taskId, async () => undefined),
                /Timed out acquiring file lock: .*timeout_ms=5000/
            );
        } finally {
            child.kill();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('propagates unexpected scan errors instead of treating completion locks as absent', () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const realFs = require('node:fs') as typeof fs & { readdirSync: typeof fs.readdirSync };
        const originalReaddirSync = realFs.readdirSync;

        try {
            realFs.readdirSync = function (..._args: unknown[]): never {
                const error = new Error('permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            };
            assert.throws(
                () => scanCompletionGateFinalizationLocks(reviewsDir),
                /permission denied/
            );
        } finally {
            realFs.readdirSync = originalReaddirSync;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
