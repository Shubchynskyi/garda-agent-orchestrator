import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runBuildReviewContextCommand } from '../../../../../../src/cli/commands/gate-build-handlers';
import { runFullSuiteValidationCommand } from '../../../../../../src/cli/commands/gates';
import {
    bindAuthoritativeRemediationDecisionToPreflight
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import {
    resolveAuthoritativeReviewRemediationDecision
} from '../../../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { fileSha256, normalizePath } from '../../../../../../src/gates/shared/helpers';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    prepareCurrentReviewPhase,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writeCompilePassEvidence,
    writePreflight,
    writeReviewCapabilitiesConfig
} from '../../gate-test-helpers';
import { seedRemediationRepoBase } from '../review-cycle/gates-review-cycle-fixtures';

describe('gate build-review-context CLI flow binding', () => {
    it('preserves custom review-context output path wiring', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-custom-output';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        const outputPath = path.join(getReviewsRoot(repoRoot), 'custom', `${taskId}-context.json`);
        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath
        });

        assert.equal(result.outputPath, normalizePath(outputPath));
        assert.equal(fs.existsSync(outputPath), true);
        assert.equal(result.outputLines.includes(`ReviewContextPath: ${normalizePath(outputPath)}`), true);
        assert.equal(result.outputLines.includes(`OutputPath: ${normalizePath(outputPath)}`), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for missing preflight path before lifecycle work', async () => {
        const repoRoot = createTempRepo();
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '2',
                preflightPath: 'garda-agent-orchestrator/runtime/reviews/missing-preflight.json'
            }),
            /Path not found/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for invalid depth at the CLI binding boundary', async () => {
        const repoRoot = createTempRepo();
        const preflightPath = writePreflight(repoRoot, 'T-review-context-cli-binding-invalid-depth');
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '4',
                preflightPath
            }),
            /Depth must be an integer between 1 and 3/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts an extensible review type while preserving canonical path resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-extensible-review';
        const reviewType = 'architecture-boundary';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeBalancedProfilesConfig(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const configRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
        const profilesPath = path.join(configRoot, 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: { balanced: { review_policy: Record<string, unknown> } };
        };
        profiles.built_in_profiles.balanced.review_policy[reviewType] = true;
        fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
        const capabilitiesPath = path.join(configRoot, 'review-capabilities.json');
        const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8')) as Record<string, boolean>;
        capabilities[reviewType] = true;
        fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(configRoot, 'review-catalog.json'), `${JSON.stringify({
            version: 1,
            custom_review_types: [{
                id: reviewType,
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'code-review',
                trigger: { mode: 'manual', signal_ids: [] },
                coverage_category_ids: ['maintainability'],
                reviewer_role: {
                    role_id: 'architecture-reviewer',
                    focus_tags: ['maintainability']
                }
            }]
        }, null, 2)}\n`, 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 7;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType,
            depth: '2',
            preflightPath
        });
        const expectedPath = normalizePath(
            path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`)
        );
        assert.equal(result.outputPath, expectedPath);
        assert.equal(fs.existsSync(result.outputPath), true);
        assert.ok(result.outputLines.includes(`ReviewContextPath: ${expectedPath}`));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rematerializes persisted remediation REUSE after full-suite evidence refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-remediation-reuse-full-suite-refresh';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        fs.mkdirSync(path.dirname(workflowConfigPath), { recursive: true });
        const workflowConfig = fs.existsSync(workflowConfigPath)
            ? JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>
            : {};
        workflowConfig.compile_gate = { command: 'node -e "process.exit(0)"' };
        workflowConfig.full_suite_validation = {
            enabled: true,
            command: 'node -e "process.exit(0)"',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        };
        workflowConfig.review_execution_policy = { mode: 'test_after_code' };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Rematerialize persisted remediation reuse after full-suite refresh',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Codex');
        runShellSmokeForTask(repoRoot, taskId, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            review_execution_policy: { mode: 'test_after_code' }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const initialFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(initialFullSuite.exitCode, 0, initialFullSuite.outputText);
        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );

        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const currentCycleFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(currentCycleFullSuite.exitCode, 0, currentCycleFullSuite.outputText);
        const preflightSha256 = fileSha256(preflightPath);
        assert.ok(preflightSha256);
        const authoritativeClassification = {
            source: 'runtime_fix' as const,
            classification: {
                category: 'test_coverage_only',
                reason: 'Test-only remediation preserves upstream code review evidence.',
                blocked_before_reuse: false,
                invalidated_review_types: ['test']
            }
        };
        const preliminaryDecision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: 'test',
                classification: authoritativeClassification,
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'test_after_code'
            }),
            preflightSha256
        );
        appendTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskId,
            'REVIEW_CYCLE_RESTARTED',
            'PASS',
            'Persisted preliminary remediation decision.',
            {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: preliminaryDecision,
                authoritative_review_classification: authoritativeClassification
            }
        );
        const currentCycleReuse = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '3',
            preflightPath
        });
        assert.equal(
            currentCycleReuse.reusedReviewEvidence,
            true,
            currentCycleReuse.outputLines.join('\n')
        );

        const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            resolveAuthoritativeReviewRemediationDecision({
                taskId,
                currentReviewType: 'test',
                classification: authoritativeClassification,
                requiredReviews: { code: true, test: true },
                reviewExecutionPolicyMode: 'test_after_code',
                reusableReceipts: [{
                    review_type: 'code',
                    reuse_status: 'ACCEPTED',
                    findings_satisfied: true,
                    evidence_kind: 'REUSED'
                }]
            }),
            preflightSha256
        );
        appendTaskEvent(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            taskId,
            'REVIEW_CYCLE_RESTARTED',
            'PASS',
            'Persisted remediation reuse decision.',
            {
                task_id: taskId,
                event_type: 'REVIEW_CYCLE_RESTARTED',
                status: 'PASSED',
                preflight_sha256: preflightSha256,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: authoritativeClassification
            }
        );

        const refreshedFullSuite = await runFullSuiteValidationCommand({ repoRoot, taskId, preflightPath });
        assert.equal(refreshedFullSuite.exitCode, 0, refreshedFullSuite.outputText);
        const rematerializedReuse = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '3',
            preflightPath
        });
        assert.equal(rematerializedReuse.reusedReviewEvidence, true);
        const rematerializedContext = JSON.parse(fs.readFileSync(codeReviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(
            (rematerializedContext.review_execution as Record<string, unknown>).source,
            'initial_full'
        );
        assert.equal(
            (rematerializedContext.full_suite_validation as Record<string, unknown>).cycle_binding_valid,
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
