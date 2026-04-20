import { randomInt } from 'node:crypto';

export const ORCHESTRATOR_START_BANNERS = Object.freeze([
    'Garda captures my mind',
    'Garda rewrites my code'
] as const);

export type OrchestratorStartBanner = (typeof ORCHESTRATOR_START_BANNERS)[number];
export const ORCHESTRATOR_START_BANNER_CONTRACT_EFFECTIVE_AT_UTC = '2026-04-20T00:00:00.000Z';

export const ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE = ORCHESTRATOR_START_BANNERS
    .map((banner) => `\`${banner}\``)
    .join(' or ');

export const FRESH_MAIN_AGENT_START_BANNER_RULE =
    'Fresh main-agent task run must emit exactly one English start banner from the repo-owned list before any edit.';

export const START_BANNER_GATE_LIST_RULE =
    'That same reply must list the first mandatory gates to run before implementation.';

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
    return `Fresh main-agent task runs must begin with exactly one English start banner from the repo-owned list (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}) before any edits and then list the first mandatory gates to run.`;
}

export function buildSetupStartBannerSentence(): string {
    return `Require the first fresh main-agent execution reply to emit exactly one English start banner from the repo-owned list (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}) before any edits and list the first gates it will run.`;
}
