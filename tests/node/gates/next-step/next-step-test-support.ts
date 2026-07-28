import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildDefaultWorkflowConfig as buildSourceDefaultWorkflowConfig,
    type WorkflowConfigData
} from '../../../../src/core/workflow-config';
import {
    getWorkspaceSnapshot as getSourceWorkspaceSnapshot
} from '../../../../src/gates/compile/compile-gate';
import {
    getWorkspaceSnapshotCached as getSourceWorkspaceSnapshotCached
} from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

function ensureGitWorkspaceFixture(repoRoot: string, changedFiles: readonly string[]): void {
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
        return;
    }

    const materializedScope = [...new Set(changedFiles)]
        .map((relativePath) => {
            const absolutePath = path.resolve(repoRoot, relativePath);
            const relativeToRoot = path.relative(repoRoot, absolutePath);
            if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                throw new Error(`Test changed-file fixture must stay inside repo root: ${relativePath}`);
            }
            const existed = fs.existsSync(absolutePath);
            const content = existed ? fs.readFileSync(absolutePath) : null;
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, Buffer.alloc(0));
            return { absolutePath, content, existed };
        });

    try {
        initGitRepo(repoRoot, {
            gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n'
        });
    } finally {
        for (const entry of materializedScope) {
            if (entry.existed && entry.content) {
                fs.writeFileSync(entry.absolutePath, entry.content);
            } else if (fs.existsSync(entry.absolutePath)) {
                fs.unlinkSync(entry.absolutePath);
            }
        }
    }
}

export function getWorkspaceSnapshot(
    ...args: Parameters<typeof getSourceWorkspaceSnapshot>
): ReturnType<typeof getSourceWorkspaceSnapshot> {
    ensureGitWorkspaceFixture(
        args[0],
        args[1] === 'explicit_changed_files' ? args[3] : []
    );
    return getSourceWorkspaceSnapshot(...args);
}

export function getWorkspaceSnapshotCached(
    ...args: Parameters<typeof getSourceWorkspaceSnapshotCached>
): ReturnType<typeof getSourceWorkspaceSnapshotCached> {
    ensureGitWorkspaceFixture(
        args[0],
        args[1] === 'explicit_changed_files' ? args[3] : []
    );
    return getSourceWorkspaceSnapshotCached(...args);
}

export function commitGitFixturePaths(
    repoRoot: string,
    relativePaths: readonly string[],
    message = 'test: refresh fixture baseline'
): void {
    runGitFixtureCommand(repoRoot, ['add', '--', ...relativePaths]);
    runGitFixtureCommand(repoRoot, ['commit', '-m', message, '--', ...relativePaths]);
}

export function getGitFixtureHead(repoRoot: string): string {
    return runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
}

export function buildDefaultWorkflowConfig(): WorkflowConfigData {
    const config = buildSourceDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = false;
    return config;
}

export { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
export {
    COPILOT_PROVIDER_ENV_KEYS,
    getProviderRuntimeEnvironmentKeys
} from '../../../../src/core/provider-registry';
export { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events-helpers';
export { recordFullSuiteValidationDuration, type FullSuiteValidationConfig } from '../../../../src/gates/full-suite/full-suite-validation';
export {
    buildReviewReuseCandidatesForDiagnostics,
    formatNextStepText,
    resolveNextStep,
    resolveNextStepDecisionRoute
} from '../../../../src/gates/next-step';
export {
    extractExplicitLinkedChildTaskIds,
    formatDecomposedTaskProvenanceNote,
    readDecomposedTaskProvenance
} from '../../../../src/gates/next-step/next-step-task-queue';
export { assessProjectMemoryImpact, getProjectMemoryImpactLifecycleEvidence } from '../../../../src/gates/project-memory-impact';
export { buildRulePackArtifact } from '../../../../src/gates/rule-pack';
export { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
export { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../../../src/gates/task-audit/task-audit-summary';
export { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
export { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
