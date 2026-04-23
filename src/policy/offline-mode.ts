/**
 * Commands that perform or may perform network operations.
 * Sorted for binary-search readability; enforcement uses a Set.
 */
export const NETWORK_SENSITIVE_COMMANDS: readonly string[] = Object.freeze([
    'bootstrap',
    'check-update',
    'install',
    'setup',
    'update'
]);

const NETWORK_SENSITIVE_SET = new Set<string>(NETWORK_SENSITIVE_COMMANDS);

/** Result of resolving the offline policy for a single command invocation. */
export interface OfflinePolicyResult {
    /** Whether offline mode is active. */
    offline: boolean;
    /** Source that activated offline mode (flag / env / config). */
    offlineSource: 'flag' | 'env' | 'config' | 'none';
    /** Whether the resolved command requires network access. */
    commandRequiresNetwork: boolean;
    /** Whether --force-network override was supplied. */
    forceNetwork: boolean;
    /** Final decision: true when the command should be blocked. */
    blocked: boolean;
    /** Human-readable reason when blocked, otherwise null. */
    reason: string | null;
}

export interface OfflinePolicyInput {
    /** --offline global flag value. */
    offlineFlag: boolean;
    /** Value of GARDA_OFFLINE env var (if any). */
    offlineEnv: string | undefined;
    /** --force-network flag value. */
    forceNetwork: boolean;
    /** The resolved command name to evaluate. */
    commandName: string;
}

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);

/**
 * Return whether offline mode is active and which source activated it.
 */
export function resolveOfflineActive(offlineFlag: boolean, offlineEnv: string | undefined): { active: boolean; source: 'flag' | 'env' | 'none' } {
    if (offlineFlag) {
        return { active: true, source: 'flag' };
    }
    if (offlineEnv !== undefined && TRUTHY_VALUES.has(offlineEnv.trim().toLowerCase())) {
        return { active: true, source: 'env' };
    }
    return { active: false, source: 'none' };
}

/**
 * Return whether a given command name is considered network-sensitive.
 */
export function isNetworkSensitiveCommand(commandName: string): boolean {
    return NETWORK_SENSITIVE_SET.has(commandName);
}

/**
 * Evaluate the offline policy for a single command invocation.
 *
 * The command is blocked when:
 *   offline mode is active AND command requires network AND --force-network is not set.
 */
export function evaluateOfflinePolicy(input: OfflinePolicyInput): OfflinePolicyResult {
    const { active, source } = resolveOfflineActive(input.offlineFlag, input.offlineEnv);
    const commandRequiresNetwork = isNetworkSensitiveCommand(input.commandName);

    if (!active) {
        return {
            offline: false,
            offlineSource: 'none',
            commandRequiresNetwork,
            forceNetwork: input.forceNetwork,
            blocked: false,
            reason: null
        };
    }

    if (!commandRequiresNetwork) {
        return {
            offline: true,
            offlineSource: source,
            commandRequiresNetwork: false,
            forceNetwork: input.forceNetwork,
            blocked: false,
            reason: null
        };
    }

    if (input.forceNetwork) {
        return {
            offline: true,
            offlineSource: source,
            commandRequiresNetwork: true,
            forceNetwork: true,
            blocked: false,
            reason: null
        };
    }

    const sourceLabel = source === 'flag'
        ? '--offline flag'
        : 'GARDA_OFFLINE environment variable';
    return {
        offline: true,
        offlineSource: source,
        commandRequiresNetwork: true,
        forceNetwork: false,
        blocked: true,
        reason:
            `Command "${input.commandName}" requires network access but offline mode is active (source: ${sourceLabel}). ` +
            'Pass --force-network to override.'
    };
}

/**
 * Assert the offline policy and throw if the command is blocked.
 * Call this from the CLI dispatcher before executing network-sensitive commands.
 */
export function assertOfflinePolicy(input: OfflinePolicyInput): OfflinePolicyResult {
    const result = evaluateOfflinePolicy(input);
    if (result.blocked) {
        throw new Error(result.reason!);
    }
    return result;
}
