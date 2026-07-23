import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { runDocImpactGateCommand, runRequiredReviewsCheckCommand } from '../../../../../src/cli/commands/gates';
import { syncTaskQueueStatusDetailed } from '../../../../../src/cli/commands/gate-flows/task/task-queue-sync';
import { runTaskAuditSummaryCommand } from '../../../../../src/cli/commands/gate-flows/task/task-summary-flow';
import { buildTaskAuditSummary } from '../../../../../src/gates/task-audit/task-audit-summary';
import { materializeReviewFindingsFollowUpTasks } from '../../../../../src/gates/review/review-findings-follow-up-tasks';
import { classifyReviewRemediationDelta } from '../../../../../src/gates/review-remediation/review-remediation-delta';
import {
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot
} from '../../../../../src/policy/review-remediation-rerun-policy';
import { syncDecomposedParentsToDone } from '../../../../../src/gates/next-step/next-step-task-queue-status-sync';
import {
    buildNoFindingsJsonReviewReport,
    buildFailedJsonReviewReport,
    createTempRepo,
    appendTaskEvent,
    getOrchestratorRoot,
    getReviewsRoot,
    attestReviewerInvocationForTest,
    prepareCurrentReviewPhase,
    runCliWithCapturedOutput,
    runEnterTaskMode,
    seedInitAnswers,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from './review-result/gates-command-review-result-fixtures';
import {
    launchArtifactInputArgsForTest,
    prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest,
    seedPromptBoundReviewFixture
} from './review-launch/gates-command-review-launch-fixtures';

async function launchAuthenticatedReviewer(fixture: Awaited<ReturnType<typeof seedPromptBoundReviewFixture>>): Promise<void> {
    const providerInvocationId = `e2e-${fixture.reviewerIdentity.replace(/[^a-z0-9]+/giu, '-')}`;
    await prepareReviewerLaunchForTest({
        repoRoot: path.resolve(fixture.reviewsRoot, '..', '..', '..'),
        taskId: path.basename(fixture.preflightPath, '-preflight.json'),
        reviewerIdentity: fixture.reviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath
    });
    const repoRoot = path.resolve(fixture.reviewsRoot, '..', '..', '..');
    const taskId = path.basename(fixture.preflightPath, '-preflight.json');
    await recordReviewerDelegationStartedForTest({
        repoRoot,
        taskId,
        reviewerIdentity: fixture.reviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath,
        providerInvocationId,
        attestationSource: 'multi_agent_v1.spawn_agent'
    });
    const completed = await runCliWithCapturedOutput([
        'gate', 'complete-reviewer-launch',
        '--task-id', taskId,
        '--review-type', 'code',
        '--repo-root', repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', fixture.reviewerIdentity,
        '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
        '--provider-invocation-id', providerInvocationId,
        '--attestation-source', 'multi_agent_v1.spawn_agent',
        ...launchArtifactInputArgsForTest(fixture.launchArtifactPath),
        '--fork-context', 'false',
        '--record-invocation'
    ], { cwd: repoRoot });
    assert.equal(completed.exitCode, 0, completed.errors.join('\n'));
}

function reviewOutputPath(repoRoot: string, taskId: string): string {
    const outputPath = path.join(
        repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'review-output.json'
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    return outputPath;
}

describe('findings policy end-to-end lifecycle', () => {
    it('completes authenticated empty-findings ingestion through final audit', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-44-clean-e2e';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            const orchestratorRoot = getOrchestratorRoot(repoRoot);
            appendTaskEvent(orchestratorRoot, taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'E2E fixture implementation started.', {});
            writeCompilePassEvidence(repoRoot, taskId, fixture.preflightPath);
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'E2E fixture review started.', {
                review_type: 'code'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'E2E fixture selected review skill.', {
                skill_id: 'code-review'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'E2E fixture loaded review skill.', {
                reference_path: '/live/skills/code-review/SKILL.md'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'E2E fixture routed reviewer.', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: fixture.reviewerIdentity,
                reviewer_fallback_reason: null,
                delegation_used: true
            });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const outputPath = reviewOutputPath(repoRoot, taskId);
            fs.writeFileSync(
                outputPath,
                `${JSON.stringify(buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
                'utf8'
            );
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));

            const reviewGate = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath: path.resolve('live/config/output-filters.json'),
                emitMetrics: false
            });
            assert.equal(reviewGate.exitCode, 0, reviewGate.outputLines.join('\n'));
            const docImpact = runDocImpactGateCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                rationale: 'Findings-only end-to-end regression adds no documentation behavior.',
                emitMetrics: false
            });
            assert.equal(docImpact.exitCode, 0, docImpact.outputLines.join('\n'));
            const completion = await runCliWithCapturedOutput([
                'gate', 'completion-gate',
                '--task-id', taskId,
                '--preflight-path', fixture.preflightPath,
                '--repo-root', repoRoot
            ], { cwd: repoRoot });
            assert.equal(completion.exitCode, 0, [...completion.errors, ...completion.logs].join('\n'));

            const finalAudit = runTaskAuditSummaryCommand({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
            assert.match(finalAudit.rendered, /Review findings audit: status=CLEAR/u);
            assert.match(finalAudit.rendered, /\[\+\] completion-gate/u);
            const audit = buildTaskAuditSummary({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
            assert.equal(audit.review_findings_audit?.status, 'CLEAR');
            assert.equal(audit.review_findings_audit?.finding_count, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds mixed dispositions to selective recovery and rejects tampered follow-up evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-44-mixed-e2e';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            await launchAuthenticatedReviewer(fixture);
            const report = buildFailedJsonReviewReport(fixture.reviewContextPath, taskId);
            const context = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
                coverage_contract: { obligations: Array<{ id: string }> };
                task_scope: { changed_files: string[] };
            };
            const ledger = report.coverage_ledger as { entries: Array<{ finding_ids: string[] }> };
            ledger.entries[0].finding_ids.push('F-002');
            (report.findings as { low: Array<Record<string, unknown>> }).low = [{
                id: 'F-002',
                title: 'Deferred hardening follow-up',
                description: 'A bounded non-blocking hardening item must be grouped after fix-now remediation.',
                evidence: [{
                    location: `${context.task_scope.changed_files[0]}:1`,
                    observation: 'The low-severity item remains bound to the authenticated review scope.'
                }],
                coverage_obligation_ids: [context.coverage_contract.obligations[0].id]
            }];
            const outputPath = reviewOutputPath(repoRoot, taskId);
            fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));

            const dispositionPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`);
            const disposition = JSON.parse(fs.readFileSync(dispositionPath, 'utf8'));
            assert.equal(disposition.disposition_result.findings.high.action, 'fix_now');
            assert.equal(disposition.disposition_result.findings.low.action, 'create_follow_up');
            const blocked = materializeReviewFindingsFollowUpTasks({ repoRoot, taskId, reviewType: 'code' });
            assert.equal(blocked.status, 'BLOCKED');
            assert.match(blocked.output_lines.join('\n'), /fix_now/iu);

            const baselinePath = path.join(fixture.reviewsRoot, `${taskId}-code-remediation-baseline.json`);
            const baselineSha256 = createHash('sha256').update(fs.readFileSync(baselinePath)).digest('hex');
            fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const remediated = true;\n', 'utf8');
            const delta = classifyReviewRemediationDelta({
                repoRoot,
                taskId,
                reviewType: 'code',
                baselineArtifactPath: baselinePath,
                baselineArtifactSha256: baselineSha256,
                currentChangedFiles: ['src/app.ts'],
                structuralTestChangedLinesThreshold: 20
            });
            assert.equal(delta.category, 'production');
            const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
            const policy = resolveReviewRemediationRerunPolicyFromSnapshot(preflight.profile_policy_snapshot).policy;
            const rerun = resolveReviewRemediationRerunLanes({
                policy,
                category: delta.category,
                currentReviewType: 'code',
                requiredReviews: preflight.required_reviews,
                reviewExecutionPolicyMode: 'strict_sequential'
            });
            assert.deepEqual(rerun.ordered_rerun_lanes, ['code']);

            disposition.items[0].action = 'ignore';
            fs.writeFileSync(dispositionPath, `${JSON.stringify(disposition, null, 2)}\n`, 'utf8');
            const tampered = materializeReviewFindingsFollowUpTasks({ repoRoot, taskId, reviewType: 'code' });
            assert.equal(tampered.status, 'BLOCKED');
            assert.ok(
                tampered.violations.some((violation) => /hash|match|binding/iu.test(violation)),
                tampered.output_lines.join('\n')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps a decomposed parent open until a materialized residual-risk follow-up completes', async () => {
        const repoRoot = createTempRepo();
        const parentTaskId = 'T-979-e2e-parent';
        const childTaskId = 'T-979-e2e-child';
        const unrelatedParentTaskId = 'T-979-e2e-unrelated-parent';
        const unrelatedTaskId = 'T-979-e2e-unrelated';
        try {
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                '## Active Queue',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| ${parentTaskId} | DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-23 | default | Execute child tasks \`${childTaskId}\` through normal gates. |`,
                `| ${childTaskId} | IN_PROGRESS | P1 | workflow | Child | gpt-5.5 | 2026-07-23 | default | Child of \`${parentTaskId}\`. |`,
                `| ${unrelatedParentTaskId} | DECOMPOSED | P1 | workflow | Unrelated parent | gpt-5.5 | 2026-07-23 | default | Review follow-up tasks materialized: \`${unrelatedTaskId}\`. |`,
                `| ${unrelatedTaskId} | DONE | P1 | workflow | Unrelated task | gpt-5.5 | 2026-07-23 | default | Complete. |`,
                ''
            ].join('\n'), 'utf8');
            seedInitAnswers(repoRoot, 'Codex');
            runEnterTaskMode({ repoRoot, taskId: childTaskId, taskSummary: 'Materialize one grouped review follow-up.' });
            const unrelatedClosure = syncDecomposedParentsToDone(
                repoRoot,
                unrelatedParentTaskId,
                [unrelatedParentTaskId]
            );
            assert.equal(unrelatedClosure.outcome, 'write_failed');
            assert.match(unrelatedClosure.error_message || '', /no longer has explicit child task links/iu);
            const preflightPath = writePreflight(repoRoot, childTaskId, {
                scope_category: 'code',
                required_reviews: { code: true }
            });
            writeReceiptBackedReviewArtifact(
                repoRoot,
                childTaskId,
                'code',
                'REVIEW FAILED',
                undefined,
                { findingSeverity: null, residualRisk: true }
            );
            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId: childTaskId,
                reviewType: 'code'
            });
            assert.equal(materialized.status, 'MATERIALIZED', materialized.violations.join('\n'));
            const followUpTaskId = materialized.created_task_ids[0];
            assert.ok(followUpTaskId);
            const followUpArtifact = JSON.parse(fs.readFileSync(materialized.artifact_path, 'utf8')) as {
                items: Array<{ source_item_kind: string }>;
            };
            assert.deepEqual(
                [...new Set(followUpArtifact.items.map((item) => item.source_item_kind))],
                ['residual_risk']
            );
            assert.equal(syncTaskQueueStatusDetailed(repoRoot, childTaskId, 'DONE').outcome, 'updated');

            const premature = syncDecomposedParentsToDone(repoRoot, parentTaskId, [parentTaskId]);
            assert.equal(premature.outcome, 'write_failed');
            assert.match(premature.error_message || '', new RegExp(`${followUpTaskId} \\(TODO\\)`, 'u'));

            const followUpPreflightPath = writePreflight(repoRoot, followUpTaskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
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
            prepareCurrentReviewPhase(repoRoot, followUpTaskId, followUpPreflightPath);
            appendTaskEvent(
                getOrchestratorRoot(repoRoot),
                followUpTaskId,
                'IMPLEMENTATION_STARTED',
                'INFO',
                'E2E residual-risk follow-up implementation started.',
                {}
            );
            writeCompilePassEvidence(repoRoot, followUpTaskId, followUpPreflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, followUpTaskId, 'code', 'REVIEW PASSED');
            const followUpReviewGate = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId: followUpTaskId,
                preflightPath: followUpPreflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath: path.resolve('live/config/output-filters.json'),
                emitMetrics: false
            });
            assert.equal(followUpReviewGate.exitCode, 0, followUpReviewGate.outputLines.join('\n'));
            const followUpDocImpact = runDocImpactGateCommand({
                repoRoot,
                taskId: followUpTaskId,
                preflightPath: followUpPreflightPath,
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                rationale: 'Residual-risk follow-up closure fixture changes no documentation.',
                emitMetrics: false
            });
            assert.equal(followUpDocImpact.exitCode, 0, followUpDocImpact.outputLines.join('\n'));
            const followUpCompletion = await runCliWithCapturedOutput([
                'gate', 'completion-gate',
                '--task-id', followUpTaskId,
                '--preflight-path', followUpPreflightPath,
                '--repo-root', repoRoot
            ], { cwd: repoRoot });
            assert.equal(
                followUpCompletion.exitCode,
                0,
                [...followUpCompletion.errors, ...followUpCompletion.logs].join('\n')
            );
            assert.match(
                fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'),
                new RegExp(`\\|\\s*${parentTaskId}\\s*\\|\\s*(?:🟩\\s*)?DONE\\s*\\|`, 'u')
            );

            const audit = buildTaskAuditSummary({
                taskId: childTaskId,
                repoRoot,
                reviewsRoot: getReviewsRoot(repoRoot)
            });
            assert.equal(audit.review_findings_audit?.status, 'CLEAR');
            assert.equal(audit.review_findings_audit?.remaining_blocker_count, 0);
            assert.equal(fs.existsSync(preflightPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
