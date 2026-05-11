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
            const codeReviewContent = '# Code Review\n## Verdict\nREVIEW PASSED';
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

            assertReviewIntegrityBlocksFinalCloseout(result, 'same_agent_fallback');
            assert.equal(result.final_closeout.implementation_summary.requested_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.effective_depth, 2);
            assert.equal(result.final_closeout.implementation_summary.path_mode, 'FULL_PATH');
            assert.deepEqual(result.final_closeout.implementation_summary.review_verdicts, {
                code: 'REVIEW PASSED',
                test: 'TEST REVIEW PASSED'
            });
            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.ok(result.final_closeout.review_trust?.visible_summary_line?.includes('incomplete or invalid'));
            assert.ok(result.final_closeout.review_trust?.policy_summary_line?.includes('asserted local review cannot satisfy mandatory independent review'));
            assert.equal(result.final_closeout.review_integrity_attestation?.same_agent_fallback_observed, true);
            assert.equal(result.final_closeout.review_integrity_attestation?.fake_or_fallback_artifacts_observed, true);
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
            assert.equal(result.final_report_contract.required_order[0], 'review integrity attestation');
            assert.equal(result.final_report_contract.required_order[2], 'git commit -m "fix(orchestration): conventional commit suggestion"');
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
            assert.equal(result.final_report_contract.required_order[0], 'review integrity attestation');
            assert.equal(result.final_report_contract.required_order[2], 'git commit -m "<type>(<scope>): <summary>"');
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
            const scratchLaunchPath = path.join(
                tmpDir,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                TASK_ID,
                'code',
                'reviewer-launch.json'
            );
            fs.mkdirSync(path.dirname(scratchLaunchPath), { recursive: true });
            fs.writeFileSync(scratchLaunchPath, '{}\n', 'utf8');

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
            assert.equal(fs.existsSync(scratchLaunchPath), false);
            assert.equal(fs.existsSync(path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID)), false);
            assert.equal(result.final_closeout.artifact_state, 'MATERIALIZED');
            assert.equal(result.evidence.find((entry) => entry.kind === 'final-closeout-json')?.exists, true);
            const closeoutJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            assert.equal(closeoutJson.artifact_state, 'MATERIALIZED');
            assert.equal(closeoutJson.workflow.visible_summary_line, 'Mandatory full-suite: false');
            assert.equal(closeoutJson.task_queue_status_contract.authority, 'gate_owned_status_sync');
            assert.deepEqual(closeoutJson.task_queue_status_contract.agent_blocked_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'SPLIT_REQUIRED']);
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Suggested commit command:'));
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Mandatory full-suite: false'));
            assert.ok(fs.readFileSync(markdownPath, 'utf8').includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
            assert.ok(renderedSummaryText.includes('Mandatory full-suite: false'));
            assert.ok(renderedSummaryText.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
            assert.ok(renderedMarkdown.includes('Do you want me to commit now? (yes/no)'));
            assert.ok(renderedMarkdown.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));
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
                    reused_count: 0,
                    fresh_count: 1,
                    completion_policy: 'ASSERTED_LOCAL_BLOCKED',
                    visible_summary_line: 'Review trust: LOCAL_ASSERTED via DELEGATED_SUBAGENT; not independent audited review.',
                    policy_summary_line: 'Review policy: asserted local review cannot satisfy mandatory independent review for this code task; use independent reviewer launch attestation or human sign-off.'
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
            assert.ok(renderedMarkdown.includes('Review policy: asserted local review cannot satisfy mandatory independent review for this code task; use independent reviewer launch attestation or human sign-off.'));
        });

        it('renders the compact agent report block with stable English labels when closeout carries agent report state', () => {
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
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Task closeout'));
            assert.ok(renderedMarkdown.includes('Language: Russian (normalized)'));
            assert.ok(renderedMarkdown.includes('Profile: balanced'));
            assert.ok(renderedMarkdown.includes('Mandatory full-suite: disabled'));
            assert.ok(renderedMarkdown.includes('Tell the agent: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('renders stable English compact report labels when closeout language is French', () => {
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
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Task closeout'));
            assert.ok(renderedMarkdown.includes('Language: French (normalized)'));
            assert.ok(renderedMarkdown.includes('Review mode: review integrity=DEGRADED_OR_UNVERIFIABLE; verdicts: code=REVIEW PASSED, test=TEST REVIEW PASSED'));
            assert.ok(renderedMarkdown.includes('Optional skills: no additional skills (generic_context_sufficient)'));
            assert.ok(renderedMarkdown.includes('Mandatory full-suite: enabled'));
            assert.ok(renderedMarkdown.includes('Tell the agent: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('renders unavailable optional-skill summaries inside the compact report block', () => {
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
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: unavailable (reason: task_events_integrity)'));
        });

        it('renders none-used optional-skill summaries inside the compact report block', () => {
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
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: none used (selected: node-backend, reason: task_text+paths)'));
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

    describe('commit guidance based on worktree state', () => {
        it('suppresses commit question when the worktree is already clean', () => {
            // Setup a clean git repo in tmpDir
            const execSync = require('node:child_process').execSync;
            execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit --allow-empty -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });

            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            // The commit question should adapt to the clean worktree
            assert.equal(
                result.final_closeout.commit_question,
                'Worktree is already clean; no further commit necessary.'
            );
            assert.equal(
                result.final_report_contract.commit_question,
                'Worktree is already clean; no further commit necessary.'
            );
            // The command suggestion should remain in the contract
            assert.ok(result.final_report_contract.required_order.includes(result.final_report_contract.commit_command_suggestion));
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
});
