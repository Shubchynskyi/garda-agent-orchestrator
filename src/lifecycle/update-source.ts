import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import { readJsonFile } from '../core/json';
import { isPathInsideRoot } from '../core/paths';
import { validateInitAnswers } from '../schemas/init-answers';

interface LiveVersionPayload {
    Version?: unknown;
}

export interface ResolvedUpdateSources {
    initAnswersResolvedPath: string;
    initAnswers: unknown;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean;
    claudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    activeAgentFilesSeed: string | null;
    previousVersion: string;
    previousVersionSource: string;
    bundleVersion: string;
    liveVersionPath: string;
}

export function getLiveVersionPayload(value: unknown): LiveVersionPayload {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as LiveVersionPayload
        : {};
}

export function resolveInitAnswersPath(normalizedTarget: string, initAnswersPath: string): string {
    const resolved = path.isAbsolute(initAnswersPath)
        ? initAnswersPath
        : path.resolve(normalizedTarget, initAnswersPath);

    if (!isPathInsideRoot(normalizedTarget, resolved)) {
        throw new Error(`InitAnswersPath must resolve inside target root '${normalizedTarget}'.`);
    }
    if (!pathExists(resolved)) {
        throw new Error(`Init answers artifact not found: ${resolved}`);
    }
    return resolved;
}

export function readInitAnswers(initAnswersResolvedPath: string): unknown {
    const raw = readTextFile(initAnswersResolvedPath);
    if (!raw.trim()) {
        throw new Error(`Init answers artifact is empty: ${initAnswersResolvedPath}`);
    }
    try {
        return JSON.parse(raw);
    } catch (_e) {
        throw new Error(`Init answers artifact is not valid JSON: ${initAnswersResolvedPath}`);
    }
}

export function detectPreviousVersion(normalizedTarget: string): {
    previousVersion: string;
    previousVersionSource: string;
    liveVersionPath: string;
} {
    const liveVersionPath = path.join(normalizedTarget, resolveBundleName(), 'live', 'version.json');
    let previousVersion = 'unknown';
    let previousVersionSource = 'missing';

    if (pathExists(liveVersionPath)) {
        try {
            const existingLiveVersion = getLiveVersionPayload(readJsonFile(liveVersionPath));
            const parsedVersion = existingLiveVersion && existingLiveVersion.Version
                ? String(existingLiveVersion.Version).trim()
                : null;
            if (parsedVersion) {
                previousVersion = parsedVersion;
                previousVersionSource = 'live/version.json';
            } else {
                previousVersionSource = existingLiveVersion && existingLiveVersion.Version !== undefined
                    ? 'live/version.json-empty'
                    : 'live/version.json-no-version-field';
            }
        } catch (_e) {
            previousVersionSource = 'live/version.json-invalid-json';
        }
    }

    return { previousVersion, previousVersionSource, liveVersionPath };
}

export function readBundleVersion(bundleRoot: string): string {
    const bundleVersionPath = path.join(bundleRoot, 'VERSION');
    if (!pathExists(bundleVersionPath)) {
        throw new Error(`Bundle version file not found: ${bundleVersionPath}`);
    }
    const bundleVersion = readTextFile(bundleVersionPath).trim();
    if (!bundleVersion) {
        throw new Error(`Bundle version file is empty: ${bundleVersionPath}`);
    }
    return bundleVersion;
}

/**
 * Full source resolution pipeline: resolves init-answers, parses them,
 * detects previous version, and reads bundle version.
 *
 * The operation order matches the original inline sequence in runUpdate:
 * resolve path → parse JSON → detect previous version → read bundle version → validate fields.
 */
export function resolveUpdateSources(
    normalizedTarget: string,
    initAnswersPath: string,
    bundleRoot: string
): ResolvedUpdateSources {
    const initAnswersResolvedPath = resolveInitAnswersPath(normalizedTarget, initAnswersPath);
    const initAnswers = readInitAnswers(initAnswersResolvedPath);

    const { previousVersion, previousVersionSource, liveVersionPath } =
        detectPreviousVersion(normalizedTarget);
    const bundleVersion = readBundleVersion(bundleRoot);

    const validated = validateInitAnswers(initAnswers);

    // Access raw ActiveAgentFiles from parsed JSON, matching original behavior.
    const rawObj = initAnswers && typeof initAnswers === 'object' && !Array.isArray(initAnswers)
        ? initAnswers as Record<string, unknown>
        : {};
    const activeAgentFilesSeed = rawObj.ActiveAgentFiles
        ? (Array.isArray(rawObj.ActiveAgentFiles)
            ? (rawObj.ActiveAgentFiles as unknown[]).join(', ')
            : String(rawObj.ActiveAgentFiles))
        : null;

    return {
        initAnswersResolvedPath,
        initAnswers,
        assistantLanguage: validated.AssistantLanguage,
        assistantBrevity: validated.AssistantBrevity,
        sourceOfTruth: validated.SourceOfTruth,
        enforceNoAutoCommit: validated.EnforceNoAutoCommit,
        claudeOrchestratorFullAccess: validated.ClaudeOrchestratorFullAccess,
        tokenEconomyEnabled: validated.TokenEconomyEnabled,
        providerMinimalism: validated.ProviderMinimalism,
        activeAgentFilesSeed,
        previousVersion,
        previousVersionSource,
        bundleVersion,
        liveVersionPath
    };
}
