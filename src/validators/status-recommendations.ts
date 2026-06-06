import * as path from 'node:path';

import { resolveProfileAwareExecuteTaskRecommendation } from './task-command';
import type {
    AgentInitializationPendingReason,
    SourceBundleParityResult
} from './status-types';
import type { ProtectedManifestAssessment } from './protected-manifest-assessment';

export interface BuildRecommendedNextCommandOptions {
    readyForTasks: boolean;
    bundlePath: string;
    parityResult: SourceBundleParityResult;
    protectedManifestAssessment: ProtectedManifestAssessment | null;
    primaryInitializationComplete: boolean;
    agentInitializationPendingReason: AgentInitializationPendingReason;
    bundlePresent: boolean;
    initAnswersPresent: boolean;
    initAnswersError: string | null;
    resolvedTargetRoot: string;
    initAnswersPath: string | undefined;
}

export function buildRecommendedNextCommand(options: BuildRecommendedNextCommandOptions): string {
    const {
        readyForTasks,
        bundlePath,
        parityResult,
        protectedManifestAssessment,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        bundlePresent,
        initAnswersPresent,
        initAnswersError,
        resolvedTargetRoot,
        initAnswersPath
    } = options;

    if (readyForTasks) {
        return resolveProfileAwareExecuteTaskRecommendation(resolvedTargetRoot, bundlePath);
    }
    if (parityResult.isStale && parityResult.remediation) {
        return parityResult.remediation;
    }

    const protectedManifestNeedsRepair = protectedManifestAssessment?.requires_refresh === true;
    if (protectedManifestNeedsRepair) {
        return `npx garda-agent-orchestrator update --target-root "${resolvedTargetRoot}"`;
    }
    if (primaryInitializationComplete && agentInitializationPendingReason !== null) {
        return `Give your agent "${path.join(bundlePath, 'AGENT_INIT_PROMPT.md')}" and complete the agent-init flow`;
    }
    if (bundlePresent && (!initAnswersPresent || initAnswersError)) {
        return `npx garda-agent-orchestrator setup --target-root "${resolvedTargetRoot}"`;
    }
    if (bundlePresent) {
        return `npx garda-agent-orchestrator install --target-root "${resolvedTargetRoot}" --init-answers-path "${initAnswersPath}"`;
    }
    return 'npx garda-agent-orchestrator setup';
}
