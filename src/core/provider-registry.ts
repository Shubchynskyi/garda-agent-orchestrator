/**
 * Canonical provider registry — the single source of truth for all provider
 * identities, entrypoints, aliases, bridge paths, and reviewer routing policy.
 *
 * Every runtime helper that needs provider metadata MUST derive it from this
 * module instead of maintaining separate hardcoded lists.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewerCapabilityTier = 'delegation_required' | 'delegation_conditional' | 'single_agent_only';

export interface ProviderEntry {
    /** Canonical provider id used across SOURCE_OF_TRUTH_VALUES, routing, and gate artifacts. */
    readonly id: string;
    /** Human-readable display label (may differ from id, e.g. 'GitHub Copilot' vs 'GitHubCopilot'). */
    readonly displayLabel: string;
    /** Canonical root entrypoint file for this provider. */
    readonly entrypointFile: string;
    /** Reviewer routing capability tier. */
    readonly reviewerCapabilityTier: ReviewerCapabilityTier;
    /** Provider orchestrator bridge definition (null when the provider has no dedicated bridge). */
    readonly bridge: ProviderBridgeDefinition | null;
    /** Known alias tokens for normalizeAgentEntrypointToken. */
    readonly aliases: readonly string[];
}

export interface ProviderBridgeDefinition {
    readonly orchestratorRelativePath: string;
    readonly gitignoreEntries: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry data
// ─────────────────────────────────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
    Object.freeze(obj);
    for (const value of Object.values(obj as object)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}

const PROVIDER_ENTRIES: readonly ProviderEntry[] = deepFreeze([
    {
        id: 'Claude',
        displayLabel: 'Claude',
        entrypointFile: 'CLAUDE.md',
        reviewerCapabilityTier: 'delegation_required',
        bridge: null,
        aliases: ['claude', 'claude.md']
    },
    {
        id: 'Codex',
        displayLabel: 'Codex',
        entrypointFile: 'AGENTS.md',
        reviewerCapabilityTier: 'delegation_required',
        bridge: null,
        aliases: ['codex', 'agents', 'agents.md']
    },
    {
        id: 'Gemini',
        displayLabel: 'Gemini',
        entrypointFile: 'GEMINI.md',
        reviewerCapabilityTier: 'single_agent_only',
        bridge: null,
        aliases: ['gemini', 'gemini.md']
    },
    {
        id: 'Qwen',
        displayLabel: 'Qwen',
        entrypointFile: 'QWEN.md',
        reviewerCapabilityTier: 'single_agent_only',
        bridge: null,
        aliases: ['qwen', 'qwen.md']
    },
    {
        id: 'GitHubCopilot',
        displayLabel: 'GitHub Copilot',
        entrypointFile: '.github/copilot-instructions.md',
        reviewerCapabilityTier: 'delegation_required',
        bridge: {
            orchestratorRelativePath: '.github/agents/orchestrator.md',
            gitignoreEntries: ['.github/agents/', '.github/copilot-instructions.md']
        },
        aliases: ['githubcopilot', 'copilot', '.github/copilot-instructions.md']
    },
    {
        id: 'Windsurf',
        displayLabel: 'Windsurf',
        entrypointFile: '.windsurf/rules/rules.md',
        reviewerCapabilityTier: 'delegation_conditional',
        bridge: {
            orchestratorRelativePath: '.windsurf/agents/orchestrator.md',
            gitignoreEntries: ['.windsurf/']
        },
        aliases: ['windsurf', '.windsurf/rules/rules.md']
    },
    {
        id: 'Junie',
        displayLabel: 'Junie',
        entrypointFile: '.junie/guidelines.md',
        reviewerCapabilityTier: 'delegation_conditional',
        bridge: {
            orchestratorRelativePath: '.junie/agents/orchestrator.md',
            gitignoreEntries: ['.junie/']
        },
        aliases: ['junie', '.junie/guidelines.md']
    },
    {
        id: 'Antigravity',
        displayLabel: 'Antigravity',
        entrypointFile: '.antigravity/rules.md',
        reviewerCapabilityTier: 'delegation_conditional',
        bridge: {
            orchestratorRelativePath: '.antigravity/agents/orchestrator.md',
            gitignoreEntries: ['.antigravity/']
        },
        aliases: ['antigravity', '.antigravity/rules.md']
    }
]);

// ─────────────────────────────────────────────────────────────────────────────
// Public accessors
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the full frozen registry. */
export function getProviderEntries(): readonly ProviderEntry[] {
    return PROVIDER_ENTRIES;
}

/** Ordered canonical provider ids (used as SOURCE_OF_TRUTH_VALUES). */
export function getProviderIds(): readonly string[] {
    return PROVIDER_ENTRIES.map((entry) => entry.id);
}

/** Map: provider id → entrypoint file. */
export function getProviderEntrypointMap(): Readonly<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const entry of PROVIDER_ENTRIES) {
        map[entry.id] = entry.entrypointFile;
    }
    return Object.freeze(map);
}

/** Ordered entrypoint file list. */
export function getProviderEntrypointFiles(): readonly string[] {
    return PROVIDER_ENTRIES.map((entry) => entry.entrypointFile);
}

/** Alias map: normalized alias → canonical entrypoint file. */
export function getProviderAliasMap(): Readonly<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const entry of PROVIDER_ENTRIES) {
        for (const alias of entry.aliases) {
            map[alias] = entry.entrypointFile;
        }
    }
    return Object.freeze(map);
}

/** Returns only providers that have orchestrator bridge definitions. */
export function getProviderBridgeEntries(): readonly ProviderEntry[] {
    return PROVIDER_ENTRIES.filter((entry) => entry.bridge !== null);
}

/** Returns the reviewer capability tier for a given canonical provider id. */
export function getReviewerCapabilityTier(providerId: string): ReviewerCapabilityTier | null {
    const entry = PROVIDER_ENTRIES.find(
        (e) => e.id.toLowerCase() === providerId.toLowerCase()
    );
    return entry ? entry.reviewerCapabilityTier : null;
}
