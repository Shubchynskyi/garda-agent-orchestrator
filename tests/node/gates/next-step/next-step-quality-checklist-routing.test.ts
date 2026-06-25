import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
    buildDefaultWorkflowConfig,
    resolveNextStep,
    type FullSuiteValidationConfig
} from './next-step-test-support';
import {
    ALL_REVIEW_FLAGS,
    TASK_ID,
    fileSha256,
    makeTempRepo,
    normalizeForTimeline,
    reviewsRoot,
    seedCompilePass,
    seedStartedTask,
    writeJson,
    writePreflight
} from './next-step-full-suite-fixtures';

type QualityChecklistStatus = 'PASS' | 'WARN' | 'ACTION_REQUIRED' | 'SKIPPED_DISABLED' | 'CONFIG_ERROR';

function workflowConfigPath(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
}

function writeWorkflowConfig(repoRoot: string, options: {
    optionalQualityChecksEnabled?: boolean;
    fullSuiteEnabled?: boolean;
    fullSuitePlacement?: FullSuiteValidationConfig['placement'];
} = {}): void {
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = options.optionalQualityChecksEnabled ?? true;
    config.full_suite_validation.enabled = options.fullSuiteEnabled ?? false;
    config.full_suite_validation.command = 'npm test';
    if (options.fullSuitePlacement) {
        config.full_suite_validation.placement = options.fullSuitePlacement;
    }
    config.review_execution_policy = { mode: 'parallel_all' };
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    writeJson(workflowConfigPath(repoRoot), config);
}

function writeQualityChecklistArtifact(
    repoRoot: string,
    taskId: string,
    status: QualityChecklistStatus,
    options: { preflightSha256?: string | null; workflowConfigSha256?: string | null } = {}
): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const actionsRequired = status === 'ACTION_REQUIRED'
        ? ['Simplify the routing helper before continuing.']
        : [];
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-quality-checklist.json`), {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'quality-checklist',
        task_id: taskId,
        checklist_id: 'optional_quality_checks',
        status,
        outcome: status === 'PASS'
            ? 'PASS'
            : status === 'WARN'
                ? 'WARN'
                : status === 'SKIPPED_DISABLED'
                    ? 'INFO'
                    : 'FAIL',
        workflow_config_path: normalizeForTimeline(workflowConfigPath(repoRoot)),
        workflow_config_sha256: options.workflowConfigSha256 === undefined
            ? fileSha256(workflowConfigPath(repoRoot))
            : options.workflowConfigSha256,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: options.preflightSha256 === undefined
            ? fileSha256(preflightPath)
            : options.preflightSha256,
        changed_file_evidence: {
            changed_files: ['src/app.ts'],
            changed_files_count: 1,
            changed_files_sha256: 'changed-files-sha',
            scope_sha256: 'scope-sha',
            scope_content_sha256: 'scope-content-sha'
        },
        rules: [],
        answers: [],
        actions_taken: [],
        actions_required: actionsRequired,
        violations: []
    });
}

describe('gates/next-step quality checklist routing', () => {
    it('routes enabled optional quality checklist before compile gate', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands[0].label, 'Run quality checklist');
        assert.ok(result.commands[0].command.includes('gate quality-checklist'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));
    });

    it('routes missing quality checklist before after-compile full-suite recovery', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            fullSuiteEnabled: true,
            fullSuitePlacement: 'after_compile_before_reviews'
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, { reviewPolicyMode: 'parallel_all' });
        seedCompilePass(repoRoot, TASK_ID, undefined, { qualityChecklist: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.ok(result.commands[0].command.includes('gate quality-checklist'));
        assert.ok(!result.commands[0].command.includes('gate full-suite-validation'));
    });

    it('skips quality checklist routing when optional checks are disabled', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, { optionalQualityChecksEnabled: false });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
    });

    it('continues to compile after current PASS quality checklist evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
    });

    it('continues through after-compile full-suite after accepted WARN evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            fullSuiteEnabled: true,
            fullSuitePlacement: 'after_compile_before_reviews'
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, { reviewPolicyMode: 'parallel_all' });
        seedCompilePass(repoRoot, TASK_ID);
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'WARN');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation', result.reason);
        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));
    });

    it('routes ACTION_REQUIRED quality checklist evidence back to implementation', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'ACTION_REQUIRED');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /Simplify the routing helper/);
    });

    it('reruns quality checklist when prior evidence is stale for the current preflight', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            preflightSha256: '0'.repeat(64)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.match(result.reason, /stale for the current preflight hash/);
    });
});
