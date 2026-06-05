export interface AgentReportInput {
    context: 'setup_handoff' | 'agent_init' | 'task_closeout';
    assistantLanguage: string | null;
    assistantLanguageConfirmed?: boolean | null;
    profileSummary?: string | null;
    reviewModeSummary?: string | null;
    optionalSkillsSummary?: string | null;
    mandatoryFullSuiteEnabled?: boolean | null;
    nextCommand?: string | null;
    nextTaskPrompt?: string | null;
    latestUpdateNotice?: string | null;
}

export interface AgentReportMessages {
    titles: Record<AgentReportInput['context'], string>;
    labels: {
        language: string;
        profile: string;
        reviewMode: string;
        optionalSkills: string;
        mandatoryFullSuite: string;
        nextCommand: string;
        nextTaskPrompt: string;
        updateNotice: string;
        noLanguage: string;
        noProfile: string;
    };
    statuses: {
        normalized: string;
        pendingConfirmation: string;
        unknown: string;
    };
    fullSuite: {
        enabled: string;
        disabled: string;
        unknown: string;
    };
    summaries: {
        mandatoryOrchestratorGates: string;
        askDuringAgentInit: string;
        confirmedDuringAgentInit: string;
        pendingDuringAgentInit: string;
        independentReviewAttested: string;
        localReview: string;
        noRequiredReview: string;
        verdicts: string;
        selected: string;
        recommendedPacks: string;
        noAdditionalSkills: string;
        unavailable: string;
        noneUsed: string;
        reason: string;
    };
}

const AGENT_REPORT_MESSAGES: AgentReportMessages = {
    titles: {
        setup_handoff: 'Setup handoff',
        agent_init: 'Agent-init summary',
        task_closeout: 'Task closeout'
    },
    labels: {
        language: 'Language',
        profile: 'Profile',
        reviewMode: 'Review mode',
        optionalSkills: 'Optional skills',
        mandatoryFullSuite: 'Mandatory full-suite',
        nextCommand: 'Next command',
        nextTaskPrompt: 'Tell the agent',
        updateNotice: 'Latest update notice',
        noLanguage: 'not recorded',
        noProfile: 'not configured'
    },
    statuses: {
        normalized: 'normalized',
        pendingConfirmation: 'pending confirmation',
        unknown: 'unknown'
    },
    fullSuite: {
        enabled: 'enabled',
        disabled: 'disabled',
        unknown: 'unknown'
    },
    summaries: {
        mandatoryOrchestratorGates: 'mandatory orchestrator gates',
        askDuringAgentInit: 'ask during AGENT_INIT_PROMPT',
        confirmedDuringAgentInit: 'confirmed during agent-init',
        pendingDuringAgentInit: 'still pending in agent-init',
        independentReviewAttested: 'independent review attested',
        localReview: 'local review',
        noRequiredReview: 'no required review',
        verdicts: 'verdicts',
        selected: 'selected',
        recommendedPacks: 'recommended packs',
        noAdditionalSkills: 'no additional skills',
        unavailable: 'unavailable',
        noneUsed: 'none used',
        reason: 'reason'
    }
};

function formatAgentReportTitle(
    context: AgentReportInput['context']
): string {
    return AGENT_REPORT_MESSAGES.titles[context];
}

function formatAgentReportLanguageStatus(
    confirmed?: boolean | null
): string {
    const messages = AGENT_REPORT_MESSAGES;
    if (confirmed === true) return messages.statuses.normalized;
    if (confirmed === false) return messages.statuses.pendingConfirmation;
    return messages.statuses.unknown;
}

function formatAgentReportFullSuite(
    enabled: boolean | null | undefined
): string {
    const messages = AGENT_REPORT_MESSAGES;
    if (enabled === true) return messages.fullSuite.enabled;
    if (enabled === false) return messages.fullSuite.disabled;
    return messages.fullSuite.unknown;
}

export function buildAgentReportBlock(input: AgentReportInput): string {
    const labels = AGENT_REPORT_MESSAGES.labels;

    const lines = [
        'GARDA_AGENT_REPORT',
        formatAgentReportTitle(input.context),
        `${labels.language}: ${(input.assistantLanguage || labels.noLanguage)} (${formatAgentReportLanguageStatus(input.assistantLanguageConfirmed)})`,
        `${labels.profile}: ${input.profileSummary || labels.noProfile}`
    ];

    if (input.reviewModeSummary) {
        lines.push(`${labels.reviewMode}: ${input.reviewModeSummary}`);
    }
    if (input.optionalSkillsSummary) {
        lines.push(`${labels.optionalSkills}: ${input.optionalSkillsSummary}`);
    }
    if (input.mandatoryFullSuiteEnabled !== undefined && input.mandatoryFullSuiteEnabled !== null) {
        lines.push(`${labels.mandatoryFullSuite}: ${formatAgentReportFullSuite(input.mandatoryFullSuiteEnabled)}`);
    }
    if (input.nextCommand) {
        lines.push(`${labels.nextCommand}: ${input.nextCommand}`);
    }
    if (input.nextTaskPrompt) {
        lines.push(`${labels.nextTaskPrompt}: ${input.nextTaskPrompt}`);
    }
    if (input.latestUpdateNotice) {
        lines.push(`${labels.updateNotice}: ${input.latestUpdateNotice}`);
    }

    return lines.join('\n');
}

export function getAgentReportMessages(): AgentReportMessages { return AGENT_REPORT_MESSAGES; }
