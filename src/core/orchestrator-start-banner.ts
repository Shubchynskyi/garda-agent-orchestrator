import { randomInt } from 'node:crypto';

export const ORCHESTRATOR_START_BANNERS = Object.freeze([
    'Garda captures my mind',
    'Garda rewrites my code'
] as const);

export type OrchestratorStartBanner = (typeof ORCHESTRATOR_START_BANNERS)[number];

export const ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE = ORCHESTRATOR_START_BANNERS
    .map((banner) => `\`${banner}\``)
    .join(' or ');

export const FRESH_MAIN_AGENT_START_BANNER_RULE =
    'At fresh main-agent task start, show one English start marker from the repo-owned list once in the first relevant reply; this UX marker is not gate evidence.';

export const START_BANNER_GATE_LIST_RULE =
    'Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.';

export const START_BANNER_EXEMPTION_RULE =
    'Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.';

export function normalizeOrchestratorStartBanner(value: unknown): OrchestratorStartBanner | null {
    const normalized = String(value || '').trim();
    return ORCHESTRATOR_START_BANNERS.find((banner) => banner === normalized) || null;
}

export function selectRandomOrchestratorStartBanner(): OrchestratorStartBanner {
    return ORCHESTRATOR_START_BANNERS[randomInt(ORCHESTRATOR_START_BANNERS.length)];
}

export function buildFreshMainAgentStartBannerSentence(): string {
    return `At fresh main-agent task start, show one English start marker from the repo-owned list (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}) once in the first relevant reply; this UX marker is not gate evidence.`;
}

export function buildSetupStartBannerSentence(): string {
    return `Ask the first fresh main-agent execution reply to show one English start marker from the repo-owned list (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}); this UX marker is not gate evidence.`;
}
