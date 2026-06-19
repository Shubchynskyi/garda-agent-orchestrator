import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProviderIds, getProviderEntrypointMap, getProviderEntrypointFiles } from './provider-registry';

export const NODE_ENGINE_RANGE = '^22.13.0 || >=24.0.0';
export const NODE_BASELINE_LABEL = 'Node 24 LTS primary; Node 22.13+ compatibility';
export const PRODUCT_NAME = 'Garda Agent Orchestrator';
export const PRODUCT_ACRONYM = 'GARDA';
export const PRODUCT_ACRONYM_EXPANSION = 'Governed Agent Runtime, Deployment, and Audit';
export const PRIMARY_PACKAGE_NAME = 'garda-agent-orchestrator';
export const LEGACY_PACKAGE_NAMES: readonly string[] = Object.freeze([]);
export const ALL_PACKAGE_NAMES: readonly string[] = Object.freeze([
    PRIMARY_PACKAGE_NAME
]);
export const DEFAULT_BUNDLE_NAME = 'garda-agent-orchestrator';
export const LEGACY_BUNDLE_NAMES: readonly string[] = Object.freeze([]);
export const ALL_BUNDLE_NAMES: readonly string[] = Object.freeze([
    DEFAULT_BUNDLE_NAME
]);
export const PRIMARY_CLI_NAME = 'garda';
export const PRIMARY_CLI_SHORT_ALIAS = 'gao';
export const LEGACY_CLI_NAMES: readonly string[] = Object.freeze([]);
export const ALL_CLI_NAMES: readonly string[] = Object.freeze([
    PRIMARY_CLI_NAME,
    PRIMARY_CLI_SHORT_ALIAS,
    PRIMARY_PACKAGE_NAME
]);
export const PRIMARY_CLI_ENTRYPOINT = 'bin/garda.js';
export const LEGACY_CLI_ENTRYPOINT = PRIMARY_CLI_ENTRYPOINT;
export const CLI_ENTRYPOINT_CANDIDATES: readonly string[] = Object.freeze([
    PRIMARY_CLI_ENTRYPOINT
]);
export const BUNDLE_NAME_ENV_VARS: readonly string[] = Object.freeze([
    'GARDA_BUNDLE_NAME'
]);

/**
 * Return the effective bundle name.
 * Resolution order: explicit override > GARDA_BUNDLE_NAME env var > DEFAULT_BUNDLE_NAME.
 */
export function resolveBundleName(override?: string): string {
    if (override && override.trim()) return override.trim();
    for (const envVar of BUNDLE_NAME_ENV_VARS) {
        const envValue = process.env[envVar];
        if (envValue && envValue.trim()) return envValue.trim();
    }
    return DEFAULT_BUNDLE_NAME;
}

function hasExplicitBundleNameConfiguration(override?: string): boolean {
    if (override && override.trim()) {
        return true;
    }
    return BUNDLE_NAME_ENV_VARS.some(function (envVar) {
        const envValue = process.env[envVar];
        return Boolean(envValue && envValue.trim());
    });
}

export function isBundleRootLike(candidateRoot: string): boolean {
    try {
        const normalizedRoot = path.resolve(candidateRoot);
        if (!fs.existsSync(normalizedRoot) || !fs.statSync(normalizedRoot).isDirectory()) {
            return false;
        }
        if (!fs.existsSync(path.join(normalizedRoot, 'VERSION'))) {
            return false;
        }
        if (!fs.existsSync(path.join(normalizedRoot, 'package.json'))) {
            return false;
        }
        return CLI_ENTRYPOINT_CANDIDATES.some(function (entrypoint) {
            return fs.existsSync(path.join(normalizedRoot, entrypoint));
        });
    } catch {
        return false;
    }
}

export function resolveBundleNameForTarget(targetRoot: string, override?: string): string {
    const preferredName = resolveBundleName(override);
    if (hasExplicitBundleNameConfiguration(override)) {
        return preferredName;
    }

    const normalizedTarget = path.resolve(targetRoot);
    const candidateRoot = path.join(normalizedTarget, preferredName);
    if (isBundleRootLike(candidateRoot)) {
        return preferredName;
    }

    try {
        const entries = fs.readdirSync(normalizedTarget, { withFileTypes: true });
        const matchingEntry = entries.find(function (entry) {
            return entry.isDirectory() && entry.name.toLowerCase() === preferredName.toLowerCase();
        });
        if (matchingEntry) {
            const matchedRoot = path.join(normalizedTarget, matchingEntry.name);
            if (isBundleRootLike(matchedRoot)) {
                return matchingEntry.name;
            }
        }
    } catch {
        // Fall back to the preferred name below.
    }

    return preferredName;
}

export function isRecognizedPackageName(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized !== '' && ALL_PACKAGE_NAMES.includes(normalized);
}

export function isRecognizedBundleName(value: unknown): boolean {
    const normalized = String(value || '').trim();
    return normalized !== '' && ALL_BUNDLE_NAMES.some((candidate) => candidate.toLowerCase() === normalized.toLowerCase());
}

export function getSourceCliCommand(): string {
    return `node ${PRIMARY_CLI_ENTRYPOINT}`;
}

export function getBundleCliCommand(bundleName?: string): string {
    return `node ${resolveBundleName(bundleName)}/${PRIMARY_CLI_ENTRYPOINT}`;
}

export function getLegacySourceCliCommand(): string {
    return getSourceCliCommand();
}

export function getLegacyBundleCliCommand(bundleName?: string): string {
    return getBundleCliCommand(bundleName);
}

export function resolveInitAnswersRelativePath(override?: string): string {
    if (override && override.trim()) return override.trim();
    return path.join(resolveBundleName(), 'runtime', 'init-answers.json');
}

export function resolveInitAnswersRelativePathForTarget(targetRoot: string, override?: string): string {
    if (override && override.trim()) return override.trim();
    return path.join(resolveBundleNameForTarget(targetRoot), 'runtime', 'init-answers.json');
}

export function resolveAgentInitStateRelativePath(override?: string): string {
    if (override && override.trim()) return override.trim();
    return path.join(resolveBundleName(), 'runtime', 'agent-init-state.json');
}

export function resolveAgentInitStateRelativePathForTarget(targetRoot: string, override?: string): string {
    if (override && override.trim()) return override.trim();
    return path.join(resolveBundleNameForTarget(targetRoot), 'runtime', 'agent-init-state.json');
}

export const LIFECYCLE_COMMANDS: readonly string[] = Object.freeze([
    'setup',
    'agent-init',
    'preprompt',
    'next-step',
    'status',
    'doctor',
    'debug',
    'stats',
    'task',
    'html',
    'ui',
    'off',
    'on',
    'bootstrap',
    'install',
    'init',
    'reinit',
    'verify',
    'check-update',
    'uninstall',
    'update',
    'rollback',
    'backup',
    'cleanup',
    'repair',
    'gc',
    'clean',
    'skills',
    'review-capabilities',
    'templates',
    'profile',
    'workflow',
    'diff-managed'
]);

export const SOURCE_OF_TRUTH_VALUES: readonly string[] = Object.freeze([...getProviderIds()]);
export const DEFAULT_AGENTS_MD_SOURCE_OF_TRUTH = 'Codex';

export const BREVITY_VALUES: readonly string[] = Object.freeze([
    'concise',
    'detailed'
]);

export const DEFAULT_ASSISTANT_LANGUAGE = 'English';
export const DEFAULT_ASSISTANT_BREVITY = BREVITY_VALUES[0];
export const DEFAULT_SOURCE_OF_TRUTH = SOURCE_OF_TRUTH_VALUES.includes(DEFAULT_AGENTS_MD_SOURCE_OF_TRUTH)
    ? DEFAULT_AGENTS_MD_SOURCE_OF_TRUTH
    : SOURCE_OF_TRUTH_VALUES[0];

export const COLLECTED_VIA_VALUES: readonly string[] = Object.freeze([
    'AGENT_INIT_PROMPT.md',
    'CLI_INTERACTIVE',
    'CLI_NONINTERACTIVE'
]);

export const BOOLEAN_TRUE_VALUES: readonly string[] = Object.freeze([
    '1',
    'true',
    'yes',
    'y',
    'on',
    'да'
]);

export const BOOLEAN_FALSE_VALUES: readonly string[] = Object.freeze([
    '0',
    'false',
    'no',
    'n',
    'off',
    'нет'
]);

export const SOURCE_TO_ENTRYPOINT_MAP = Object.freeze(getProviderEntrypointMap());

export const ALL_AGENT_ENTRYPOINT_FILES = Object.freeze([...getProviderEntrypointFiles()]);

export const MANAGED_CONFIG_NAMES: readonly string[] = Object.freeze([
    'review-capabilities',
    'paths',
    'token-economy',
    'output-filters',
    'skill-packs',
    'optional-skill-selection-policy',
    'isolation-mode',
    'profiles',
    'review-artifact-storage',
    'runtime-retention',
    'workflow-config'
]);

export const LEGACY_FULL_SUITE_VALIDATION_COMMAND = 'npm test';
export const UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND = '__FULL_SUITE_COMMAND_UNCONFIGURED__';
export const UNCONFIGURED_COMPILE_GATE_COMMAND = '__COMPILE_GATE_COMMAND_UNCONFIGURED__';

export const DEFAULT_METRICS_FILE_NAME = 'metrics.jsonl';

export const TOXIN_METRIC_TYPES: readonly string[] = Object.freeze([
    'disk_artifact_growth',
    'stale_locks',
    'cleanup_candidates',
    'gate_overhead',
    'noisy_outputs'
]);
