import { resolveBundleName, ALL_AGENT_ENTRYPOINT_FILES, SOURCE_OF_TRUTH_VALUES, SOURCE_TO_ENTRYPOINT_MAP } from '../core/constants';

type SourceOfTruthValue = keyof typeof SOURCE_TO_ENTRYPOINT_MAP;

export const SHARED_START_TASK_WORKFLOW_RELATIVE_PATH = '.agents/workflows/start-task.md';

const ACTIVE_AGENT_FILE_ALIAS_MAP: Record<string, string> = {
    'claude': 'CLAUDE.md',
    'claude.md': 'CLAUDE.md',
    'codex': 'AGENTS.md',
    'agents': 'AGENTS.md',
    'agents.md': 'AGENTS.md',
    'gemini': 'GEMINI.md',
    'gemini.md': 'GEMINI.md',
    'qwen': 'QWEN.md',
    'qwen.md': 'QWEN.md',
    'githubcopilot': '.github/copilot-instructions.md',
    'copilot': '.github/copilot-instructions.md',
    '.github/copilot-instructions.md': '.github/copilot-instructions.md',
    'windsurf': '.windsurf/rules/rules.md',
    '.windsurf/rules/rules.md': '.windsurf/rules/rules.md',
    'junie': '.junie/guidelines.md',
    '.junie/guidelines.md': '.junie/guidelines.md',
    'antigravity': '.antigravity/rules.md',
    '.antigravity/rules.md': '.antigravity/rules.md'
};

/**
 * Resolves a source-of-truth provider name to its canonical entrypoint file.
 */
export function getCanonicalEntrypointFile(sourceOfTruth: string): string {
    const key = String(sourceOfTruth).trim();
    const match = SOURCE_OF_TRUTH_VALUES.find(
        (v) => v.toLowerCase() === key.toLowerCase().replace(/\s+/g, '')
    ) as SourceOfTruthValue | undefined;
    if (!match) {
        throw new Error(`Unsupported SourceOfTruth value '${sourceOfTruth}'.`);
    }
    return SOURCE_TO_ENTRYPOINT_MAP[match];
}

/**
 * Normalizes a single agent entrypoint token (alias, number, or path) to a canonical file.
 */
export function normalizeAgentEntrypointToken(token: string): string | null {
    let trimmed = String(token).trim();
    trimmed = trimmed.replace(/^or\s+/i, '');
    if (!trimmed) {
        return null;
    }

    const selectionNumber = Number.parseInt(trimmed, 10);
    if (/^\d+$/.test(trimmed) && !Number.isNaN(selectionNumber)) {
        if (selectionNumber < 1 || selectionNumber > ALL_AGENT_ENTRYPOINT_FILES.length) {
            throw new Error(
                `Unsupported ActiveAgentFiles selection '${token}'. Choose a number from 1 to ${ALL_AGENT_ENTRYPOINT_FILES.length}, or use one of: ${ALL_AGENT_ENTRYPOINT_FILES.join(', ')}.`
            );
        }
        return ALL_AGENT_ENTRYPOINT_FILES[selectionNumber - 1];
    }

    const normalized = trimmed.toLowerCase().replace(/\\/g, '/');
    if (ACTIVE_AGENT_FILE_ALIAS_MAP[normalized]) {
        return ACTIVE_AGENT_FILE_ALIAS_MAP[normalized];
    }

    const caseMatch = ALL_AGENT_ENTRYPOINT_FILES.find(
        (v) => v.toLowerCase() === trimmed.toLowerCase()
    );
    if (caseMatch) {
        return caseMatch;
    }

    throw new Error(
        `Unsupported ActiveAgentFiles entry '${token}'. Allowed values: ${ALL_AGENT_ENTRYPOINT_FILES.join(', ')}. You may also use provider aliases such as Claude, Codex, Gemini, Qwen, Copilot, Windsurf, Junie, or Antigravity.`
    );
}

/**
 * Resolves active agent entrypoint files from a comma/semicolon-separated value
 * and/or a source-of-truth provider name. Returns ordered canonical array.
 */
export function getActiveAgentEntrypointFiles(value: unknown, sourceOfTruthValue: unknown): string[] {
    const selected = new Set<string>();

    if (value && String(value).trim()) {
        for (const token of String(value).split(/[,;]/)) {
            const normalized = normalizeAgentEntrypointToken(token);
            if (normalized) {
                selected.add(normalized);
            }
        }
    }

    if (sourceOfTruthValue && String(sourceOfTruthValue).trim()) {
        selected.add(getCanonicalEntrypointFile(String(sourceOfTruthValue)));
    }

    const ordered: string[] = [];
    for (const allowed of ALL_AGENT_ENTRYPOINT_FILES) {
        if (selected.has(allowed)) {
            ordered.push(allowed);
        }
    }

    return ordered;
}

/**
 * Converts an array of active entrypoint files to a comma-separated string.
 */
export function convertActiveAgentEntrypointFilesToString(activeEntrypointFiles: unknown): string | null {
    if (!activeEntrypointFiles || !Array.isArray(activeEntrypointFiles)) {
        return null;
    }

    const normalized: string[] = [];
    const selectedSet = new Set<string>();
    for (const entry of activeEntrypointFiles) {
        if (!entry || !String(entry).trim()) continue;
        const token = normalizeAgentEntrypointToken(entry);
        if (token && !selectedSet.has(token)) {
            selectedSet.add(token);
        }
    }

    for (const allowed of ALL_AGENT_ENTRYPOINT_FILES) {
        if (selectedSet.has(allowed)) {
            normalized.push(allowed);
        }
    }

    return normalized.length === 0 ? null : normalized.join(', ');
}

/**
 * Returns provider orchestrator profile definitions.
 */
export function getProviderOrchestratorProfileDefinitions() {
    return [
        {
            entrypointFile: '.github/copilot-instructions.md',
            providerLabel: 'GitHub Copilot',
            orchestratorRelativePath: '.github/agents/orchestrator.md',
            gitignoreEntries: ['.github/agents/', '.github/copilot-instructions.md']
        },
        {
            entrypointFile: '.windsurf/rules/rules.md',
            providerLabel: 'Windsurf',
            orchestratorRelativePath: '.windsurf/agents/orchestrator.md',
            gitignoreEntries: ['.windsurf/']
        },
        {
            entrypointFile: '.junie/guidelines.md',
            providerLabel: 'Junie',
            orchestratorRelativePath: '.junie/agents/orchestrator.md',
            gitignoreEntries: ['.junie/']
        },
        {
            entrypointFile: '.antigravity/rules.md',
            providerLabel: 'Antigravity',
            orchestratorRelativePath: '.antigravity/agents/orchestrator.md',
            gitignoreEntries: ['.antigravity/']
        }
    ];
}

export function getLegacyManagedGitignoreEntries(): string[] {
    return [
        '.antigravity/rules.md',
        '.junie/guidelines.md',
        '.windsurf/rules/rules.md'
    ];
}

/**
 * Returns the managed .gitignore superset that should exist immediately after setup/install,
 * even before agent-init expands ActiveAgentFiles.
 *
 * When `activeEntryFiles` is provided (provider minimalism mode), only the active provider
 * entrypoints and their associated bridge directories are included instead of all providers.
 */
export function getManagedGitignoreEntries(
    enableClaudeOrchestratorFullAccess = false,
    activeEntryFiles?: readonly string[]
): string[] {
    const selected = new Set<string>([
        resolveBundleName() + '/',
        'TASK.md',
        '.qwen/',
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
    ]);

    if (activeEntryFiles) {
        const activeSet = new Set(activeEntryFiles);
        const directoryScopedProviderEntrypoints = new Set<string>(getLegacyManagedGitignoreEntries());

        for (const entrypointFile of activeEntryFiles) {
            if (directoryScopedProviderEntrypoints.has(entrypointFile)) {
                continue;
            }
            selected.add(entrypointFile);
        }

        for (const profile of getProviderOrchestratorProfileDefinitions()) {
            if (!activeSet.has(profile.entrypointFile)) continue;
            for (const gitignoreEntry of profile.gitignoreEntries) {
                selected.add(gitignoreEntry);
            }
        }
    } else {
        const directoryScopedProviderEntrypoints = new Set<string>(getLegacyManagedGitignoreEntries());

        for (const entrypointFile of ALL_AGENT_ENTRYPOINT_FILES) {
            if (directoryScopedProviderEntrypoints.has(entrypointFile)) {
                continue;
            }
            selected.add(entrypointFile);
        }

        for (const profile of getProviderOrchestratorProfileDefinitions()) {
            for (const gitignoreEntry of profile.gitignoreEntries) {
                selected.add(gitignoreEntry);
            }
        }
    }

    if (enableClaudeOrchestratorFullAccess) {
        selected.add('.claude/');
    }

    return [...selected].sort();
}

export function getManagedGitignoreCleanupEntries(
    enableClaudeOrchestratorFullAccess = false,
    activeEntryFiles?: readonly string[]
): string[] {
    const selected = new Set<string>(getManagedGitignoreEntries(enableClaudeOrchestratorFullAccess, activeEntryFiles));
    for (const legacyEntry of getLegacyManagedGitignoreEntries()) {
        selected.add(legacyEntry);
    }
    return [...selected].sort();
}

/**
 * Returns GitHub skill bridge profile definitions.
 */
export function getGitHubSkillBridgeProfileDefinitions() {
    return [
        {
            relativePath: '.github/agents/reviewer.md',
            profileTitle: 'Reviewer Bridge',
            skillPath: resolveBundleName() + '/live/skills/orchestration/SKILL.md',
            reviewRequirement: 'Use preflight `required_reviews.*` flags from orchestrator.',
            capabilityFlag: 'always-on'
        },
        {
            relativePath: '.github/agents/code-review.md',
            profileTitle: 'Code Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/code-review/SKILL.md',
            reviewRequirement: 'required_reviews.code=true',
            capabilityFlag: 'always-on'
        },
        {
            relativePath: '.github/agents/db-review.md',
            profileTitle: 'DB Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/db-review/SKILL.md',
            reviewRequirement: 'required_reviews.db=true',
            capabilityFlag: 'always-on'
        },
        {
            relativePath: '.github/agents/security-review.md',
            profileTitle: 'Security Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/security-review/SKILL.md',
            reviewRequirement: 'required_reviews.security=true',
            capabilityFlag: 'always-on'
        },
        {
            relativePath: '.github/agents/refactor-review.md',
            profileTitle: 'Refactor Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/refactor-review/SKILL.md',
            reviewRequirement: 'required_reviews.refactor=true',
            capabilityFlag: 'always-on'
        },
        {
            relativePath: '.github/agents/api-review.md',
            profileTitle: 'API Review Bridge',
            skillPath: `${resolveBundleName()}/live/skills/api-contract-review/SKILL.md (or custom ${resolveBundleName()}/live/skills/api-review/SKILL.md when present)`,
            reviewRequirement: 'required_reviews.api=true',
            capabilityFlag: 'review-capabilities.api=true'
        },
        {
            relativePath: '.github/agents/test-review.md',
            profileTitle: 'Test Review Bridge',
            skillPath: `${resolveBundleName()}/live/skills/testing-strategy/SKILL.md (or custom ${resolveBundleName()}/live/skills/test-review/SKILL.md when present)`,
            reviewRequirement: 'required_reviews.test=true',
            capabilityFlag: 'review-capabilities.test=true'
        },
        {
            relativePath: '.github/agents/performance-review.md',
            profileTitle: 'Performance Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/performance-review/SKILL.md',
            reviewRequirement: 'required_reviews.performance=true',
            capabilityFlag: 'review-capabilities.performance=true'
        },
        {
            relativePath: '.github/agents/infra-review.md',
            profileTitle: 'Infra Review Bridge',
            skillPath: `${resolveBundleName()}/live/skills/devops-k8s/SKILL.md (or custom ${resolveBundleName()}/live/skills/infra-review/SKILL.md when present)`,
            reviewRequirement: 'required_reviews.infra=true',
            capabilityFlag: 'review-capabilities.infra=true'
        },
        {
            relativePath: '.github/agents/dependency-review.md',
            profileTitle: 'Dependency Review Bridge',
            skillPath: resolveBundleName() + '/live/skills/dependency-review/SKILL.md',
            reviewRequirement: 'required_reviews.dependency=true',
            capabilityFlag: 'review-capabilities.dependency=true'
        }
    ];
}
