/**
 * Update source trust policy for the orchestrator update lifecycle.
 *
 * Default behavior (trusted mode):
 * - Only allowlisted npm package names and git repository URLs are accepted.
 * - Local source paths (--source-path) are rejected.
 *
 * Override:
 * - Ordinary bypass requires explicit trustOverride: true from the caller.
 * - The environment variable is ignored in normal runtime flows and can only
 *   be enabled deliberately for test-only harness paths.
 * - Overridden sources are clearly flagged in the result.
 */

export const TRUSTED_GIT_REPO_URLS = Object.freeze([
    'https://github.com/Shubchynskyi/garda-agent-orchestrator.git',
    'https://github.com/Shubchynskyi/garda-agent-orchestrator'
]);

export const TRUSTED_NPM_PACKAGE_NAMES = Object.freeze([
    'garda-agent-orchestrator'
]);

export const TRUST_OVERRIDE_ENV_VAR = 'GARDA_UPDATE_TRUST_OVERRIDE';
export const LEGACY_TRUST_OVERRIDE_ENV_VAR = TRUST_OVERRIDE_ENV_VAR;

interface TrustOverrideOptions {
    trustOverride?: boolean;
    allowEnvTrustOverride?: boolean;
}

export type TrustOverrideSource = 'cli-flag' | 'env-test-only';

export interface TrustValidationResult {
    trusted: boolean;
    overridden: boolean;
    policy: 'overridden' | 'enforced';
    overrideSource: TrustOverrideSource | null;
}

interface ParsedNpmPackageSpec {
    name: string;
    version: string | null;
}

function isTruthyEnvValue(value: string): boolean {
    return value === '1' || value === 'true' || value === 'yes';
}

function isTestOnlyEnvTrustOverrideRuntime(): boolean {
    return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'test';
}

export function resolveTrustOverrideSource(options?: TrustOverrideOptions | null): TrustOverrideSource | null {
    if (options && options.trustOverride === true) {
        return 'cli-flag';
    }
    if (!options || options.allowEnvTrustOverride !== true) {
        return null;
    }
    if (!isTestOnlyEnvTrustOverrideRuntime()) {
        return null;
    }
    const envValue = String(process.env[TRUST_OVERRIDE_ENV_VAR] || '').trim().toLowerCase();
    return isTruthyEnvValue(envValue) ? 'env-test-only' : null;
}

/**
 * Returns true when the caller has explicitly opted out of trust enforcement.
 * Ordinary runtime flows only honour the explicit option; the environment
 * variable is reserved for test-only paths that opt into it.
 */
export function isTrustOverrideActive(options?: TrustOverrideOptions | null): boolean {
    return resolveTrustOverrideSource(options) !== null;
}

export function assertExplicitCliTrustOverride(commandName: string, options?: {
    trustOverride?: boolean;
    noPrompt?: boolean;
} | null): void {
    if (!options || options.trustOverride !== true) {
        return;
    }
    if (options.noPrompt === true) {
        return;
    }
    throw new Error(
        `${commandName} trust override requires explicit non-interactive acknowledgement. ` +
        'Rerun with both --trust-override and --no-prompt.'
    );
}

/**
 * Normalises a git URL for comparison: trims whitespace, strips trailing
 * slashes and the optional .git suffix, then lowercases.
 */
export function normalizeGitUrl(url: string): string {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
}

export function isGitRepoUrlTrusted(repoUrl: string): boolean {
    const normalized = normalizeGitUrl(repoUrl);
    for (const trusted of TRUSTED_GIT_REPO_URLS) {
        if (normalizeGitUrl(trusted) === normalized) return true;
    }
    return false;
}

/**
 * Parses an npm package spec into { name, version }.
 * Returns null for specs that are not valid package-name references
 * (local paths, URLs, tarballs, etc.).
 */
export function parseNpmPackageSpec(spec: string): ParsedNpmPackageSpec | null {
    const trimmed = String(spec || '').trim();
    if (!trimmed) return null;

    if (/^[./\\]/.test(trimmed)) return null;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('@')) return null;
    if (/\.(tgz|tar\.gz|tar)$/i.test(trimmed)) return null;

    if (trimmed.startsWith('@')) {
        const slashIdx = trimmed.indexOf('/');
        if (slashIdx < 0) return null;
        const afterSlash = trimmed.substring(slashIdx + 1);
        const atIdx = afterSlash.indexOf('@');
        if (atIdx < 0) {
            return { name: trimmed, version: null };
        }
        return {
            name: trimmed.substring(0, slashIdx + 1 + atIdx),
            version: afterSlash.substring(atIdx + 1) || null
        };
    }

    const atIdx = trimmed.indexOf('@');
    if (atIdx < 0) {
        return { name: trimmed, version: null };
    }
    return {
        name: trimmed.substring(0, atIdx),
        version: trimmed.substring(atIdx + 1) || null
    };
}

export function isNpmPackageSpecTrusted(packageSpec: string): boolean {
    const parsed = parseNpmPackageSpec(packageSpec);
    if (!parsed || !parsed.name) return false;
    return TRUSTED_NPM_PACKAGE_NAMES.includes(parsed.name.toLowerCase());
}

export function validateGitSourceTrust(repoUrl: string, options?: TrustOverrideOptions | null): TrustValidationResult {
    const overrideSource = resolveTrustOverrideSource(options);
    if (overrideSource) {
        return { trusted: false, overridden: true, policy: 'overridden', overrideSource };
    }
    if (isGitRepoUrlTrusted(repoUrl)) {
        return { trusted: true, overridden: false, policy: 'enforced', overrideSource: null };
    }
    throw new Error(
        `Update source trust policy rejected git repository '${repoUrl}'. ` +
        `Only allowlisted repositories are accepted in trusted mode. ` +
        `Trusted: ${TRUSTED_GIT_REPO_URLS.join(', ')}. ` +
        'Use --trust-override together with --no-prompt to bypass.'
    );
}

export function validateNpmSourceTrust(packageSpec: string, options?: TrustOverrideOptions | null): TrustValidationResult {
    const overrideSource = resolveTrustOverrideSource(options);
    if (overrideSource) {
        return { trusted: false, overridden: true, policy: 'overridden', overrideSource };
    }
    if (isNpmPackageSpecTrusted(packageSpec)) {
        return { trusted: true, overridden: false, policy: 'enforced', overrideSource: null };
    }
    throw new Error(
        `Update source trust policy rejected npm package spec '${packageSpec}'. ` +
        `Only allowlisted package names are accepted in trusted mode. ` +
        `Trusted: ${TRUSTED_NPM_PACKAGE_NAMES.join(', ')}. ` +
        'Use --trust-override together with --no-prompt to bypass.'
    );
}

export function validatePathSourceTrust(sourcePath: string, options?: TrustOverrideOptions | null): TrustValidationResult {
    const overrideSource = resolveTrustOverrideSource(options);
    if (overrideSource) {
        return { trusted: false, overridden: true, policy: 'overridden', overrideSource };
    }
    throw new Error(
        `Update source trust policy rejected local source path '${sourcePath}'. ` +
        `Local source paths are not accepted in trusted mode. ` +
        'Use --trust-override together with --no-prompt to bypass.'
    );
}
