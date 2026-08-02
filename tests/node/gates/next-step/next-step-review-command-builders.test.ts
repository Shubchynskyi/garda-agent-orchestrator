import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildCompleteReviewerLaunchCommand,
    buildRecordReviewerDelegationStartedCommand,
    buildRecordReviewerInvocationCommand,
    buildRestartReviewCycleCommand
} from '../../../../src/gates/next-step/next-step-review-command-builders';
import { quoteCommandValue } from '../../../../src/core/command-quoting';

function writeTaskMode(repoRoot: string, taskId: string, payload: Record<string, unknown> = {}): string {
    const taskModePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
    fs.mkdirSync(path.dirname(taskModePath), { recursive: true });
    fs.writeFileSync(taskModePath, JSON.stringify({
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        orchestrator_work: true,
        workflow_config_work: true,
        ...payload
    }, null, 2) + '\n', 'utf8');
    return taskModePath;
}

describe('gates/next-step review command builders', () => {
    it('carries source-checkout workflow-config scope in restart-review-cycle commands', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-scope-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-SCOPE-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts', 'live/config/workflow-config.json'],
                triggers: {
                    changed_workflow_config_files: ['template/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'live/config/workflow-config.json': 'a'.repeat(64),
                        'template/config/workflow-config.json': 'b'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');
            const taskModePath = writeTaskMode(repoRoot, 'T-SCOPE');

            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-SCOPE',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-SCOPE-preflight.json',
                taskModePath
            );

            assert.ok(command.includes('--changed-file "live/config/workflow-config.json"'), command);
            assert.ok(command.includes('--changed-file "template/config/workflow-config.json"'), command);
            assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits workflow-config scope in restart-review-cycle commands without workflow-config task-mode authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-omit-config-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-SCOPE-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: [
                    'src/app.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'b'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');
            const taskModePath = writeTaskMode(repoRoot, 'T-SCOPE', { workflow_config_work: false });

            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-SCOPE',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-SCOPE-preflight.json',
                taskModePath,
                ['garda-agent-orchestrator/template/config/workflow-config.json']
            );

            assert.ok(command.includes('--changed-file "src/app.ts"'), command);
            assert.ok(!command.includes('garda-agent-orchestrator/live/config/workflow-config.json'), command);
            assert.ok(!command.includes('garda-agent-orchestrator/template/config/workflow-config.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('carries ordinary changed-file scope in restart-review-cycle commands when no workflow-config paths exist', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-ordinary-scope-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-SCOPE-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts'],
                triggers: {}
            }, null, 2) + '\n', 'utf8');

            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-SCOPE',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-SCOPE-preflight.json',
                null
            );

            assert.ok(command.includes('gate restart-review-cycle'), command);
            assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('can omit all changed-file scope for evidence-only restart-review-cycle commands', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-evidence-only-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-SCOPE-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts'],
                triggers: {}
            }, null, 2) + '\n', 'utf8');

            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-SCOPE',
                'Refresh review evidence only',
                'garda-agent-orchestrator/runtime/reviews/T-SCOPE-preflight.json',
                null,
                ['src/additional.ts'],
                {
                    includeChangedFileScope: false,
                    reviewType: 'api',
                    reviewEvidenceOnly: true
                }
            );

            assert.ok(command.includes('gate restart-review-cycle'), command);
            assert.ok(command.includes('--review-type "api"'), command);
            assert.ok(command.includes('--review-evidence-only'), command);
            assert.ok(!command.includes('--changed-file'), command);
            assert.ok(!command.includes('src/app.ts'), command);
            assert.ok(!command.includes('src/additional.ts'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds restart-review-cycle commands to the active preflight path', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-'));
        try {
            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-CUSTOM',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/custom reviews/T-CUSTOM-preflight.json',
                null
            );

            assert.ok(command.includes('gate restart-review-cycle'), command);
            assert.ok(
                command.includes('--preflight-path "garda-agent-orchestrator/runtime/custom reviews/T-CUSTOM-preflight.json"'),
                command
            );
            assert.ok(!command.includes('runtime/reviews/T-CUSTOM-preflight.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits source-checkout generated runtime manifest while retaining executable dist runtime', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-generated-'));
        try {
            fs.writeFileSync(
                path.join(repoRoot, 'package.json'),
                JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n',
                'utf8'
            );
            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-GENERATED',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-GENERATED-preflight.json',
                null,
                [
                    'dist/publish-runtime-manifest.json',
                    'dist/src/gates/next-step/next-step.js',
                    'garda-agent-orchestrator/runtime/manual-validation/T-GENERATED/evidence.txt'
                ]
            );

            assert.ok(command.includes('gate restart-review-cycle'), command);
            assert.ok(command.includes('--changed-file "garda-agent-orchestrator/runtime/manual-validation/T-GENERATED/evidence.txt"'), command);
            assert.ok(command.includes('--changed-file "dist/src/gates/next-step/next-step.js"'), command);
            assert.ok(!command.includes('--changed-file "dist/publish-runtime-manifest.json"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps dist source files in restart-review-cycle commands outside source checkout', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-app-dist-'));
        try {
            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-APP-DIST',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-APP-DIST-preflight.json',
                null,
                [
                    'dist/src/app.js',
                    'dist/publish-runtime-manifest.json'
                ]
            );

            assert.ok(command.includes('--changed-file "dist/src/app.js"'), command);
            assert.ok(command.includes('--changed-file "dist/publish-runtime-manifest.json"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('shell-quotes every persisted reviewer launch value in recovery commands', () => {
        const dangerousProviderInvocationId = 'provider-$(whoami)`x`"q";echo pwn;\'tail';
        const dangerousControllerInvocationId = 'controller-$(whoami)`x`"q";echo pwn;\'tail';
        const dangerousAttestationSource = 'source-$(whoami)`x`"q";echo pwn;\'tail';
        const dangerousReviewerIdentity = 'agent:reviewer-$(whoami)`x`"q";echo pwn;\'tail';
        const dangerousLaunchArtifactPath = 'runtime/reviews/$(whoami)`x`"q";touch pwn;\'tail.json';
        const dangerousLaunchInputArtifactPath = 'runtime/reviews/input-$(whoami)`x`"q";touch pwn;\'tail.json';
        const dangerousLaunchInputSha256 = 'sha-$(whoami)`x`"q";echo pwn;\'tail';

        const delegationStartCommand = buildRecordReviewerDelegationStartedCommand({
            cliPrefix: 'node bin/garda.js',
            taskId: 'T-SAFE-RECOVERY',
            reviewType: 'code',
            reviewerIdentity: dangerousReviewerIdentity,
            launchArtifactPath: dangerousLaunchArtifactPath,
            launchInputMode: 'launch_artifact_path',
            launchInputArtifactPath: dangerousLaunchInputArtifactPath,
            launchInputSha256: dangerousLaunchInputSha256,
            providerInvocationId: dangerousProviderInvocationId,
            attestationSource: dangerousAttestationSource
        });
        const completionCommand = buildCompleteReviewerLaunchCommand({
            cliPrefix: 'node bin/garda.js',
            taskId: 'T-SAFE-RECOVERY',
            reviewType: 'code',
            reviewerIdentity: dangerousReviewerIdentity,
            launchArtifactPath: dangerousLaunchArtifactPath,
            launchInputMode: 'copy_paste_prompt',
            launchInputSha256: dangerousLaunchInputSha256,
            controllerInvocationId: dangerousControllerInvocationId,
            attestationSource: dangerousAttestationSource,
            recordInvocation: true
        });
        const invocationCommand = buildRecordReviewerInvocationCommand(
            '.',
            'node bin/garda.js',
            'T-SAFE-RECOVERY',
            'code',
            dangerousReviewerIdentity,
            dangerousLaunchArtifactPath,
            null
        );

        for (const [command, flag, value] of [
            [delegationStartCommand, '--provider-invocation-id', dangerousProviderInvocationId],
            [completionCommand, '--controller-invocation-id', dangerousControllerInvocationId],
            [delegationStartCommand, '--attestation-source', dangerousAttestationSource],
            [completionCommand, '--attestation-source', dangerousAttestationSource],
            [delegationStartCommand, '--reviewer-identity', dangerousReviewerIdentity],
            [completionCommand, '--reviewer-identity', dangerousReviewerIdentity],
            [invocationCommand, '--reviewer-identity', dangerousReviewerIdentity],
            [delegationStartCommand, '--reviewer-launch-artifact-path', dangerousLaunchArtifactPath],
            [completionCommand, '--reviewer-launch-artifact-path', dangerousLaunchArtifactPath],
            [invocationCommand, '--reviewer-launch-artifact-path', dangerousLaunchArtifactPath],
            [delegationStartCommand, '--launch-input-artifact-path', dangerousLaunchInputArtifactPath],
            [delegationStartCommand, '--launch-input-sha256', dangerousLaunchInputSha256],
            [completionCommand, '--launch-input-sha256', dangerousLaunchInputSha256]
        ] as const) {
            assert.ok(
                command.includes(`${flag} ${quoteCommandValue(value)}`),
                `${flag} must use shell-safe quoting: ${command}`
            );
            assert.equal(
                command.includes(`${flag} "${value}"`),
                false,
                `${flag} must not interpolate persisted values into raw double quotes`
            );
        }
    });
});
