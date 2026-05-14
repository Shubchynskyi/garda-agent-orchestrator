import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInstall } from '../../../src/materialization/install';
import {
    findRepoRoot,
    setupTestWorkspace,
    writeInitAnswers
} from './install-workspace-builder';

describe('runInstall — provider bridges and start-task router', () => {
    const repoRoot = findRepoRoot();

    it('creates provider bridges when GitHubCopilot is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'reviewer.md')));
            const orchestratorBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md'), 'utf8');
            const apiBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'api-review.md'), 'utf8');
            const infraBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'infra-review.md'), 'utf8');
            assert.ok(orchestratorBridge.includes('dependent downstream reviewer'));
            assert.ok(orchestratorBridge.includes('upstream PASS artifact and receipt'));
            assert.ok(orchestratorBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(orchestratorBridge.includes('ReviewLaunchableBatch'));
            assert.ok(orchestratorBridge.includes('BlockedReviewLanes'));
            assert.ok(apiBridge.includes('api-contract-review'));
            assert.ok(infraBridge.includes('devops-k8s'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates the shared start-task router for root entrypoint providers too', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const entrypointPath = path.join(projectRoot, 'AGENTS.md');
            assert.ok(fs.existsSync(workflowPath));
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            const entrypoint = fs.readFileSync(entrypointPath, 'utf8');
            assert.ok(workflow.includes('shared start-task router'));
            assert.ok(workflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(workflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(workflow.includes('ReviewLaunchableBatch'));
            assert.ok(workflow.includes('BlockedReviewLanes'));
            assert.ok(entrypoint.includes('.agents/workflows/start-task.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates Antigravity bridge checklist workflow when Antigravity is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Antigravity',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Antigravity',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.antigravity', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            assert.ok(fs.existsSync(bridgePath));
            assert.ok(fs.existsSync(workflowPath));
            const bridge = fs.readFileSync(bridgePath, 'utf8');
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(bridge.includes('.agents/workflows/start-task.md'));
            assert.ok(bridge.includes('dependent downstream reviewer'));
            assert.ok(bridge.includes('upstream PASS artifact and receipt'));
            assert.ok(bridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(bridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(bridge.includes('build:node-foundation'));
            assert.ok(workflow.includes('gate enter-task-mode'));
            assert.ok(workflow.includes('gate completion-gate'));
            assert.ok(workflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(workflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('refreshes stale managed dependent-reviewer wording on rerun install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const staleBridge = fs.readFileSync(bridgePath, 'utf8')
                .replace(
                    'Dependency order is a launch-time contract even on delegation-capable platforms: do not launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.',
                    'Treat downstream `test` review as dependency-ordered even on delegation-capable platforms; do not fan it out in parallel with required upstream non-`test` reviews.'
                )
                .replace(
                    'Parallel reviewer fan-out is allowed only between independent review types with no dependency edge for the current cycle.',
                    'Do not treat downstream reviewers as speculative sidecars.'
                )
                .replace(
                    'Do not fan out known producer-consumer validation commands as raw shell sidecars around the gate flow. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    'Treat generated-artifact validation as best-effort shell fan-out and let local runners coordinate freshness opportunistically.'
                );
            const staleWorkflow = fs.readFileSync(workflowPath, 'utf8')
                .replace(
                    '- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.',
                    '- Do not spawn downstream `test` reviewers before upstream code review finishes.'
                )
                .replace(
                    '- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.',
                    '- Do not parallelize dependent reviews.'
                )
                .replace(
                    '- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    '- Treat generated-artifact validation fan-out as acceptable when it is only local shell coordination.'
                );
            assert.notEqual(staleBridge, fs.readFileSync(bridgePath, 'utf8'));
            assert.ok(staleBridge.includes('Treat downstream `test` review as dependency-ordered even on delegation-capable platforms'));
            assert.ok(staleBridge.includes('Do not treat downstream reviewers as speculative sidecars.'));
            assert.ok(!staleBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleBridge.includes('Treat generated-artifact validation as best-effort shell fan-out'));
            assert.notEqual(staleWorkflow, fs.readFileSync(workflowPath, 'utf8'));
            assert.ok(staleWorkflow.includes('Do not spawn downstream `test` reviewers before upstream code review finishes.'));
            assert.ok(staleWorkflow.includes('Do not parallelize dependent reviews.'));
            assert.ok(!staleWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleWorkflow.includes('Treat generated-artifact validation fan-out as acceptable'));
            fs.writeFileSync(bridgePath, staleBridge, 'utf8');
            fs.writeFileSync(workflowPath, staleWorkflow, 'utf8');

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const refreshedBridge = fs.readFileSync(bridgePath, 'utf8');
            const refreshedWorkflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(refreshedBridge.includes('dependent downstream reviewer'));
            assert.ok(refreshedBridge.includes('upstream PASS artifact and receipt'));
            assert.ok(refreshedBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedBridge.includes('ReviewLaunchableBatch'));
            assert.ok(refreshedBridge.includes('BlockedReviewLanes'));
            assert.ok(refreshedBridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedBridge.includes('build:node-foundation'));
            assert.ok(refreshedWorkflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(refreshedWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedWorkflow.includes('ReviewLaunchableBatch'));
            assert.ok(refreshedWorkflow.includes('BlockedReviewLanes'));
            assert.ok(refreshedWorkflow.includes('failed current reviews take remediation priority'));
            assert.ok(refreshedWorkflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedWorkflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});
