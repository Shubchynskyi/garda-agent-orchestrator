import * as path from 'node:path';

/**
 * Canonical provider registry — the single source of truth for all provider
 * identities, entrypoints, aliases, bridge paths, and reviewer routing policy.
 *
 * Every runtime helper that needs provider metadata MUST derive it from this
 * module instead of maintaining separate hardcoded lists.
 */

export type ReviewerCapabilityTier = 'delegation_required' | 'delegation_conditional' | 'single_agent_only';
export type ProviderBridgeProfileVariant = 'standard' | 'compact_router';
export type ProviderBridgeSelfReferenceRequirement = 'none' | 'bridge_path';

export interface ProviderEntry {
    /** Canonical provider id used across SOURCE_OF_TRUTH_VALUES, routing, and gate artifacts. */
    readonly id: string;
    /** Human-readable display label (may differ from id, e.g. 'GitHub Copilot' vs 'GitHubCopilot'). */
    readonly displayLabel: string;
    /** Optional provider label used in generated reviewer-launch instructions. */
    readonly reviewerLaunchLabel?: string;
    /** Canonical root entrypoint file for this provider. */
    readonly entrypointFile: string;
    /** Reviewer routing capability tier. */
    readonly reviewerCapabilityTier: ReviewerCapabilityTier;
    /** Optional provider-specific delegated reviewer launch guidance. */
    readonly delegatedReviewerLaunchInstruction?: string;
    /** Provider orchestrator bridge definition (null when the provider has no dedicated bridge). */
    readonly bridge: ProviderBridgeDefinition | null;
    /** Known alias tokens for normalizeAgentEntrypointToken. */
    readonly aliases: readonly string[];
}

export interface ProviderBridgeDefinition {
    readonly orchestratorRelativePath: string;
    readonly managedDirectoryRelativePath: string;
    readonly gitignoreEntries: readonly string[];
    readonly entrypointCoveredByDirectoryIgnore: boolean;
    readonly profileVariant: ProviderBridgeProfileVariant;
    readonly reviewSkillBridgeHost: boolean;
    readonly selfReferenceRequirement: ProviderBridgeSelfReferenceRequirement;
}

function deepFreeze<T>(obj: T): T {
    Object.freeze(obj);
    for (const value of Object.values(obj as object)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}

function normalizeRegistryPath(value: string): string {
    return String(value || '').trim().replace(/\\/g, '/');
}

function validateProviderEntries(entries: readonly ProviderEntry[]): void {
    const reviewSkillBridgeHosts = entries.filter((entry) => entry.bridge?.reviewSkillBridgeHost);
    if (reviewSkillBridgeHosts.length !== 1) {
        throw new Error(
            `Provider registry must define exactly one review-skill bridge host; found ${reviewSkillBridgeHosts.length}.`
        );
    }

    for (const entry of entries) {
        if (!entry.reviewerLaunchLabel?.trim()) {
            throw new Error(`Delegation-required provider '${entry.id}' is missing reviewerLaunchLabel.`);
        }
        if (!entry.delegatedReviewerLaunchInstruction?.trim()) {
            throw new Error(`Delegation-required provider '${entry.id}' is missing delegatedReviewerLaunchInstruction.`);
        }

        if (!entry.bridge) {
            continue;
        }

        const normalizedBridgePath = normalizeRegistryPath(entry.bridge.orchestratorRelativePath);
        const normalizedManagedDirectory = normalizeRegistryPath(entry.bridge.managedDirectoryRelativePath);
        const expectedManagedDirectory = path.posix.dirname(normalizedBridgePath);
        if (normalizedManagedDirectory !== expectedManagedDirectory) {
            throw new Error(
                `Provider '${entry.id}' bridge directory '${entry.bridge.managedDirectoryRelativePath}' does not match bridge path '${entry.bridge.orchestratorRelativePath}'.`
            );
        }
        if (entry.bridge.profileVariant === 'compact_router' && entry.bridge.selfReferenceRequirement !== 'bridge_path') {
            throw new Error(
                `Provider '${entry.id}' compact_router bridge must require selfReferenceRequirement='bridge_path'.`
            );
        }
        if (entry.bridge.selfReferenceRequirement === 'bridge_path' && entry.bridge.profileVariant !== 'compact_router') {
            throw new Error(
                `Provider '${entry.id}' bridge_path self-reference requirement requires profileVariant='compact_router'.`
            );
        }

        const normalizedEntrypoint = normalizeRegistryPath(entry.entrypointFile);
        const directoryIgnoreEntries = entry.bridge.gitignoreEntries
            .map((gitignoreEntry) => normalizeRegistryPath(gitignoreEntry))
            .filter((gitignoreEntry) => gitignoreEntry.endsWith('/'));
        const entrypointCoveredByDirectoryIgnore = directoryIgnoreEntries.some((gitignoreEntry) => (
            normalizedEntrypoint.startsWith(gitignoreEntry)
        ));
        if (entrypointCoveredByDirectoryIgnore !== entry.bridge.entrypointCoveredByDirectoryIgnore) {
            throw new Error(
                `Provider '${entry.id}' entrypointCoveredByDirectoryIgnore does not match gitignoreEntries coverage.`
            );
        }
    }
}

const PROVIDER_ENTRIES: readonly ProviderEntry[] = deepFreeze([
    {
        id: 'Claude',
        displayLabel: 'Claude',
        reviewerLaunchLabel: 'Claude Code',
        entrypointFile: 'CLAUDE.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via Agent tool (`fork_context=false`).',
        bridge: null,
        aliases: ['claude', 'claude.md']
    },
    {
        id: 'Codex',
        displayLabel: 'Codex',
        reviewerLaunchLabel: 'Codex',
        entrypointFile: 'AGENTS.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via sub-agents with isolated context.',
        bridge: null,
        aliases: ['codex', 'agents', 'agents.md']
    },
    {
        id: 'Cursor',
        displayLabel: 'Cursor',
        reviewerLaunchLabel: 'Cursor',
        entrypointFile: 'AGENTS.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: null,
        aliases: ['cursor']
    },
    {
        id: 'Gemini',
        displayLabel: 'Gemini',
        reviewerLaunchLabel: 'Gemini',
        entrypointFile: 'GEMINI.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: null,
        aliases: ['gemini', 'gemini.md']
    },
    {
        id: 'Qwen',
        displayLabel: 'Qwen',
        reviewerLaunchLabel: 'Qwen',
        entrypointFile: 'QWEN.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: null,
        aliases: ['qwen', 'qwen.md']
    },
    {
        id: 'GitHubCopilot',
        displayLabel: 'GitHub Copilot',
        reviewerLaunchLabel: 'GitHub Copilot CLI',
        entrypointFile: '.github/copilot-instructions.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via `task` tool with `agent_type=\"general-purpose\"` (one reviewer per isolated task run).',
        bridge: {
            orchestratorRelativePath: '.github/agents/orchestrator.md',
            managedDirectoryRelativePath: '.github/agents',
            gitignoreEntries: ['.github/agents/', '.github/copilot-instructions.md'],
            entrypointCoveredByDirectoryIgnore: false,
            profileVariant: 'standard',
            reviewSkillBridgeHost: true,
            selfReferenceRequirement: 'none'
        },
        aliases: ['githubcopilot', 'copilot', '.github/copilot-instructions.md']
    },
    {
        id: 'Windsurf',
        displayLabel: 'Windsurf',
        reviewerLaunchLabel: 'Windsurf',
        entrypointFile: '.windsurf/rules/rules.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: {
            orchestratorRelativePath: '.windsurf/agents/orchestrator.md',
            managedDirectoryRelativePath: '.windsurf/agents',
            gitignoreEntries: ['.windsurf/'],
            entrypointCoveredByDirectoryIgnore: true,
            profileVariant: 'standard',
            reviewSkillBridgeHost: false,
            selfReferenceRequirement: 'none'
        },
        aliases: ['windsurf', '.windsurf/rules/rules.md']
    },
    {
        id: 'Junie',
        displayLabel: 'Junie',
        reviewerLaunchLabel: 'Junie',
        entrypointFile: '.junie/guidelines.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: {
            orchestratorRelativePath: '.junie/agents/orchestrator.md',
            managedDirectoryRelativePath: '.junie/agents',
            gitignoreEntries: ['.junie/'],
            entrypointCoveredByDirectoryIgnore: true,
            profileVariant: 'standard',
            reviewSkillBridgeHost: false,
            selfReferenceRequirement: 'none'
        },
        aliases: ['junie', '.junie/guidelines.md']
    },
    {
        id: 'Antigravity',
        displayLabel: 'Antigravity',
        reviewerLaunchLabel: 'Antigravity',
        entrypointFile: '.antigravity/rules.md',
        reviewerCapabilityTier: 'delegation_required',
        delegatedReviewerLaunchInstruction: 'launch clean-context reviewers via delegated reviewer sub-agents with isolated context.',
        bridge: {
            orchestratorRelativePath: '.antigravity/agents/orchestrator.md',
            managedDirectoryRelativePath: '.antigravity/agents',
            gitignoreEntries: ['.antigravity/'],
            entrypointCoveredByDirectoryIgnore: true,
            profileVariant: 'compact_router',
            reviewSkillBridgeHost: false,
            selfReferenceRequirement: 'bridge_path'
        },
        aliases: ['antigravity', '.antigravity/rules.md']
    }
]);
validateProviderEntries(PROVIDER_ENTRIES);

/** Returns the full frozen registry. */
export function getProviderEntries(): readonly ProviderEntry[] {
    return PROVIDER_ENTRIES;
}

/** Returns one provider entry by canonical id (case-insensitive). */
export function getProviderEntryById(providerId: string): ProviderEntry | null {
    const normalizedProviderId = String(providerId || '').trim().toLowerCase();
    if (!normalizedProviderId) {
        return null;
    }
    return PROVIDER_ENTRIES.find((entry) => entry.id.toLowerCase() === normalizedProviderId) || null;
}

/** Returns one provider entry by orchestrator bridge path (case-insensitive). */
export function getProviderEntryByBridgePath(bridgeRelativePath: string): ProviderEntry | null {
    const normalizedBridgePath = String(bridgeRelativePath || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!normalizedBridgePath) {
        return null;
    }
    return PROVIDER_ENTRIES.find((entry) => (
        entry.bridge?.orchestratorRelativePath.replace(/\\/g, '/').toLowerCase() === normalizedBridgePath
    )) || null;
}

/** Returns one provider entry by bridge path or throws when the registry is inconsistent. */
export function getRequiredProviderEntryByBridgePath(bridgeRelativePath: string): ProviderEntry {
    const entry = getProviderEntryByBridgePath(bridgeRelativePath);
    if (!entry) {
        throw new Error(`Provider registry does not define bridge path '${bridgeRelativePath}'.`);
    }
    return entry;
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
    const files = new Set<string>();
    for (const entry of PROVIDER_ENTRIES) {
        files.add(entry.entrypointFile);
    }
    return Object.freeze([...files]);
}

/** Returns the canonical entrypoint file for one provider id. */
export function getProviderEntrypointFileById(providerId: string): string | null {
    return getProviderEntryById(providerId)?.entrypointFile ?? null;
}

/** Returns every provider entry that shares one canonical entrypoint file. */
export function getProviderEntriesByEntrypointFile(entrypointFile: string): readonly ProviderEntry[] {
    const normalizedEntrypointFile = String(entrypointFile || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!normalizedEntrypointFile) {
        return Object.freeze([]);
    }
    return Object.freeze(PROVIDER_ENTRIES.filter((entry) => (
        entry.entrypointFile.replace(/\\/g, '/').toLowerCase() === normalizedEntrypointFile
    )));
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

/** Returns the single provider that hosts GitHub review-skill bridge profiles. */
export function getReviewSkillBridgeHostEntry(): ProviderEntry | null {
    return getProviderBridgeEntries().find((entry) => entry.bridge!.reviewSkillBridgeHost) || null;
}

/** Returns the unique review-skill bridge host entry or throws when the registry is inconsistent. */
export function getRequiredReviewSkillBridgeHostEntry(): ProviderEntry {
    const hostEntries = getProviderBridgeEntries().filter((entry) => entry.bridge!.reviewSkillBridgeHost);
    if (hostEntries.length !== 1) {
        throw new Error(
            `Provider registry must define exactly one review-skill bridge host; found ${hostEntries.length}.`
        );
    }
    return hostEntries[0];
}

/** Ordered provider bridge file paths. */
export function getProviderBridgeRelativePaths(): readonly string[] {
    return getProviderBridgeEntries().map((entry) => entry.bridge!.orchestratorRelativePath);
}

/** Ordered provider bridge directory paths. */
export function getProviderBridgeDirectoryPaths(): readonly string[] {
    const directories = new Set<string>();
    for (const entry of getProviderBridgeEntries()) {
        directories.add(entry.bridge!.managedDirectoryRelativePath.replace(/\\/g, '/'));
    }
    return Object.freeze([...directories].sort());
}

/**
 * Entrypoints whose provider bridge already ignores the containing directory,
 * so adding the file path separately would duplicate provider metadata.
 */
export function getDirectoryScopedProviderEntrypointFiles(): readonly string[] {
    const scopedEntrypoints = new Set<string>();
    for (const entry of getProviderBridgeEntries()) {
        if (entry.bridge!.entrypointCoveredByDirectoryIgnore) {
            scopedEntrypoints.add(entry.entrypointFile);
        }
    }
    return Object.freeze([...scopedEntrypoints].sort());
}

/** Returns the reviewer capability tier for a given canonical provider id. */
export function getReviewerCapabilityTier(providerId: string): ReviewerCapabilityTier | null {
    return getProviderEntryById(providerId)?.reviewerCapabilityTier ?? null;
}
