import { spawn } from 'node:child_process';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    type TaskAuditSummaryResult
} from '../../../src/gates/task-audit-summary';
import {
    inspectCompletionGateFinalizationLock,
    scanCompletionGateFinalizationLocks,
    withCompletionGateFinalizationLockAsync
} from '../../../src/gates/finalization-lock';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'task-audit-test-'));
}

function writeEvent(eventsDir: string, taskId: string, event: Record<string, unknown>): void {
    const file = path.join(eventsDir, `${taskId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
}

function writePreflight(reviewsDir: string, taskId: string, data: Record<string, unknown>): void {
    fs.writeFileSync(
        path.join(reviewsDir, `${taskId}-preflight.json`),
        JSON.stringify(data),
        'utf8'
    );
}

function writeArtifact(reviewsDir: string, taskId: string, suffix: string, data: unknown): void {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    fs.writeFileSync(path.join(reviewsDir, `${taskId}${suffix}`), content, 'utf8');
}

function writeActiveCompletionLock(reviewsDir: string, taskId: string): string {
    const lockPath = path.join(reviewsDir, `${taskId}-completion-gate.lock`);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
    return lockPath;
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

        it('returns PASS when completion gate is present and no blockers', () => {
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
            assert.equal(result.final_report_contract.blocker, null);
        });

        it('builds a canonical final closeout payload from task-mode, review-gate, doc-impact, and token-economy evidence', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile gate passed.',
                details: {
                    output_telemetry: {
                        estimated_saved_tokens: 62,
                        raw_token_count_estimate: 180,
                        filtered_token_count_estimate: 118
                    }
                }
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
            writeArtifact(reviewsDir, TASK_ID, '-code.md', codeReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-test.md', testReviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: crypto.createHash('sha256').update(codeReviewContent, 'utf8').digest('hex')
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                review_artifact_sha256: crypto.createHash('sha256').update(testReviewContent, 'utf8').digest('hex')
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
            assert.equal(result.final_closeout.implementation_summary.docs_updated, true);
            assert.deepEqual(result.final_closeout.docs.docs_updated, ['docs/cli-reference.md']);
            assert.ok(result.final_closeout.token_economy?.visible_summary_line?.includes('Saved tokens: ~62'));
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, false);
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
            assert.equal(fs.existsSync(jsonPath), true);
            assert.equal(fs.existsSync(markdownPath), true);
            assert.equal(result.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
            assert.ok(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).artifact_state === 'MATERIALIZED');
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Suggested commit command:'));
            assert.ok(renderedMarkdown.includes('Do you want me to commit now? (yes/no)'));
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
            assert.equal(inspection.lock_path, lockPath);
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
        const readdirMock = mock.method(fs, 'readdirSync', () => {
            const error = new Error('permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
        });

        try {
            assert.throws(
                () => scanCompletionGateFinalizationLocks(reviewsDir),
                /permission denied/
            );
        } finally {
            readdirMock.mock.restore();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
