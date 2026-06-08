import type { StatusSnapshot as CliStatusSnapshot } from '../../cli/commands/cli-helpers';
import type { collectTimelineSummaryForStatus } from '../../gate-runtime/timeline-summary';
import type { ProtectedControlPlaneManifestEvidence } from '../../gates/shared/helpers';
import type { readAgentInitStateSafe } from '../../runtime/agent-init-state';
import type { ToxinStatusSummary } from '../../runtime/toxin-metrics';
import type { validateInitAnswers } from '../../schemas/init-answers';
import type { ProtectedManifestAssessment } from '../protected-manifest-assessment';
import type { ProviderComplianceResult } from '../provider-compliance';
import type { detectSourceBundleParity } from '../workspace-layout';

export type InitAnswers = ReturnType<typeof validateInitAnswers>;

export interface LiveVersionPayload {
    Version?: unknown;
    SourceOfTruth?: unknown;
    EnforceNoAutoCommit?: unknown;
}

export type AgentInitStateResult = ReturnType<typeof readAgentInitStateSafe>;
export type AgentInitState = NonNullable<AgentInitStateResult['state']>;
export type AgentInitializationPendingReason = CliStatusSnapshot['agentInitializationPendingReason'];
export type TimelineSummary = ReturnType<typeof collectTimelineSummaryForStatus>;
export type SourceBundleParityResult = ReturnType<typeof detectSourceBundleParity>;

export interface InitAnswersState {
    resolvedPath: string;
    present: boolean;
    answers: InitAnswers | null;
    error: string | null;
}

export interface LiveVersionState {
    payload: LiveVersionPayload | null;
    error: string | null;
}

export interface StatusSnapshot extends CliStatusSnapshot {
    enforceNoAutoCommit: boolean | null;
    initAnswersPathForDisplay: string;
    initAnswersPresent: boolean;
    taskPresent: boolean;
    livePresent: boolean;
    usagePresent: boolean;
    agentInitStatePath: string;
    agentInitState: AgentInitState | null;
    timelineTaskCount: number;
    timelineHealthy: number;
    timelineWarnings: string[];
    parityResult: SourceBundleParityResult;
    providerComplianceResult: ProviderComplianceResult | null;
    protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null;
    protectedManifestAssessment: ProtectedManifestAssessment | null;
    toxinMetricsSummary: ToxinStatusSummary | null;
}
