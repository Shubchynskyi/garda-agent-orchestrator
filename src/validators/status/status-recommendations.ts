import * as path from 'node:path';

import { quoteCommandValue } from '../../core/command-quoting';
import { resolveProfileAwareExecuteTaskRecommendation } from '../task-command';
import type {
    AgentInitializationPendingReason,
    SourceBundleParityResult
} from './status-types';
import type { ProtectedManifestAssessment } from '../protected-manifest-assessment';

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

export interface AgentInitializationRecoveryGuidance {
    primary: string;
    alternatives: string[];
}

export function buildAgentInitializationRecoveryGuidance(options: {
    bundlePath: string;
    resolvedTargetRoot: string;
    agentInitializationPendingReason: AgentInitializationPendingReason;
}): AgentInitializationRecoveryGuidance {
    const promptPath = path.join(options.bundlePath, 'AGENT_INIT_PROMPT.md');
    const quotedTargetRoot = quoteCommandValue(options.resolvedTargetRoot);
    const agentInitCommand = `node garda-agent-orchestrator/bin/garda.js agent-init --target-root ${quotedTargetRoot}`;
    const primary = `Give your agent "${promptPath}" and complete the agent-init flow, then run ${agentInitCommand}`;
    const alternatives: string[] = [];

    if (options.agentInitializationPendingReason === 'PROJECT_COMMANDS_PENDING') {
        alternatives.push(
            `garda workflow set --compile-gate-command "<compile/build/type-check command>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root ${quotedTargetRoot}`
        );
    }

    return { primary, alternatives };
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
        return buildAgentInitializationRecoveryGuidance({
            bundlePath,
            resolvedTargetRoot,
            agentInitializationPendingReason
        }).primary;
    }
    if (bundlePresent && (!initAnswersPresent || initAnswersError)) {
        return `npx garda-agent-orchestrator setup --target-root "${resolvedTargetRoot}"`;
    }
    if (bundlePresent) {
        return `npx garda-agent-orchestrator install --target-root "${resolvedTargetRoot}" --init-answers-path "${initAnswersPath}"`;
    }
    return 'npx garda-agent-orchestrator setup';
}
