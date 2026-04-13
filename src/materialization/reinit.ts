import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists, readTextFile } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';
import { validateInitAnswers, serializeInitAnswers } from '../schemas/init-answers';
import {
    buildRefreshAgentInitState,
    createAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../runtime/agent-init-state';
import { getCanonicalEntrypointFile, getActiveAgentEntrypointFiles, convertActiveAgentEntrypointFilesToString } from './common';
import { applyAssistantDefaults } from './rule-materialization';
import { runInstall } from './install';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { getExpectedBundleInvariantPaths, validateBundleInvariants } from '../validators/workspace-layout';
import { resolveBundleName } from '../core/constants';
import { cleanupStaleTaskEventLocks } from '../gate-runtime/task-events';
import { withLifecycleOperationLock } from '../lifecycle/common';

interface ReinitOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    overrides?: Record<string, unknown>;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
}

export interface ReinitChange {
    key: string;
    action: string;
    value: string;
    source: string;
    note: string;
}

interface InitAnswerInference {
    source: 'version.json' | 'token-economy.json';
    property: string;
}

interface InitAnswerSchemaEntry {
    key: string;
    defaultValue: string;
    inferFrom: InitAnswerInference[] | null;
}

interface RecollectInitAnswersOptions {
    existingAnswers?: Record<string, unknown> | null;
    liveVersion?: Record<string, unknown> | null;
    tokenEconomyConfig?: Record<string, unknown> | null;
    overrides?: Record<string, unknown>;
    changes?: ReinitChange[];
}

type RecollectedInitAnswers = Record<string, string> & { CollectedVia: string };

function asObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Runs the reinit pipeline.
 * Node implementation of the reinit lifecycle.
 *
 * @param {object} options
 * @param {string} options.targetRoot - Project root
 * @param {string} options.bundleRoot - Orchestrator bundle dir
 * @param {string} [options.initAnswersPath] - Relative or absolute path to init-answers.json
 * @param {object} [options.overrides] - CLI parameter overrides for answers
 * @param {boolean} [options.skipVerify=false]
 * @param {boolean} [options.skipManifestValidation=false]
 * @returns {object} Reinit result
 */
export function runReinit(options: ReinitOptions) {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = resolveBundleName() + '/runtime/init-answers.json',
        overrides = {},
        skipVerify = false,
        skipManifestValidation = false
    } = options;

    const sourceRoot = path.join(bundleRoot, 'template');
    const expectedInvariantPaths = getExpectedBundleInvariantPaths(bundleRoot);
    if (!pathExists(sourceRoot)) {
        throw new Error(`Template directory not found: ${sourceRoot}`);
    }

    // Validate target root
    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }

    return withLifecycleOperationLock(normalizedTarget, 'reinit', () => {
    // Resolve init answers path
    const resolvedInitPath = path.isAbsolute(initAnswersPath)
        ? initAnswersPath
        : path.resolve(targetRoot, initAnswersPath);

    // Read bundle version from the deployed runtime.
    const bundleVersionPath = path.join(bundleRoot, 'VERSION');
    if (!pathExists(bundleVersionPath)) {
        throw new Error(`Bundle version file not found: ${bundleVersionPath}`);
    }
    const bundleVersion = readTextFile(bundleVersionPath).trim();

    const previousAgentInitStateResult = readAgentInitStateSafe(normalizedTarget);
    const previousAgentInitState = previousAgentInitStateResult.state;

    // Load existing answers if present
    let existingAnswers: Record<string, unknown> | null = null;
    if (pathExists(resolvedInitPath)) {
        try {
            existingAnswers = asObjectRecord(readJsonFile(resolvedInitPath));
        } catch {
            existingAnswers = null;
        }
    }

    // Load existing live/version.json for inference
    const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
    let existingLiveVersion: Record<string, unknown> | null = null;
    if (pathExists(liveVersionPath)) {
        try {
            existingLiveVersion = asObjectRecord(readJsonFile(liveVersionPath));
        } catch {
            existingLiveVersion = null;
        }
    }

    // Load existing token-economy config
    const tokenEconomyConfigPath = path.join(bundleRoot, 'live', 'config', 'token-economy.json');
    let existingTokenEconomyConfig: Record<string, unknown> | null = null;
    if (pathExists(tokenEconomyConfigPath)) {
        try {
            existingTokenEconomyConfig = asObjectRecord(readJsonFile(tokenEconomyConfigPath));
        } catch {
            existingTokenEconomyConfig = null;
        }
    }

    // Recollect init answers (apply overrides, preserve existing, use defaults)
    const changes: ReinitChange[] = [];
    const initAnswers = recollectInitAnswers({
        existingAnswers,
        liveVersion: existingLiveVersion,
        tokenEconomyConfig: existingTokenEconomyConfig,
        overrides,
        changes
    });

    // Validate final answers
    const validated = validateInitAnswers(initAnswers);
    const resolvedLanguage = validated.AssistantLanguage;
    const resolvedBrevity = validated.AssistantBrevity;
    const resolvedSourceOfTruth = validated.SourceOfTruth;
    const resolvedEnforceNoAutoCommit = validated.EnforceNoAutoCommit;
    const resolvedClaudeOrchestratorFullAccess = validated.ClaudeOrchestratorFullAccess;
    const resolvedTokenEconomyEnabled = validated.TokenEconomyEnabled;
    const resolvedProviderMinimalism = validated.ProviderMinimalism;
    const resolvedActiveFiles = validated.ActiveAgentFiles || [];
    const resolvedActiveAgentFilesStr = convertActiveAgentEntrypointFilesToString(resolvedActiveFiles);

    // Prepare serializable answers
    const serializedAnswers = serializeInitAnswers({
        ...initAnswers,
        ActiveAgentFiles: resolvedActiveFiles
    });

    // Validate git dir if enforceNoAutoCommit
    if (resolvedEnforceNoAutoCommit) {
        const gitDir = path.join(targetRoot, '.git');
        if (!pathExists(gitDir)) {
            throw new Error(
                `EnforceNoAutoCommit=true but .git directory is missing at '${gitDir}'. Initialize git or rerun reinit with EnforceNoAutoCommit=false.`
            );
        }
    }

    // Write init answers
    ensureDirectory(path.dirname(resolvedInitPath));
    writeJsonFile(resolvedInitPath, serializedAnswers);

    // Update core rule file
    const coreRuleUpdated = updateCoreRuleFile(bundleRoot, sourceRoot, resolvedLanguage, resolvedBrevity);

    // Update token economy config
    const tokenEconomyUpdated = updateTokenEconomyConfig(bundleRoot, sourceRoot, resolvedTokenEconomyEnabled);

    // Run answer-dependent install pass
    runInstall({
        targetRoot,
        bundleRoot,
        preserveExisting: true,
        alignExisting: true,
        runInit: false,
        answerDependentOnly: true,
        skipBackups: true,
        assistantLanguage: resolvedLanguage,
        assistantBrevity: resolvedBrevity,
        sourceOfTruth: resolvedSourceOfTruth,
        initAnswersPath: resolvedInitPath
    });

    const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {        
        AssistantLanguage: resolvedLanguage,
        SourceOfTruth: resolvedSourceOfTruth,
        ActiveAgentFiles: resolvedActiveFiles
    });
    writeAgentInitState(normalizedTarget, buildRefreshAgentInitState({
        previousState: previousAgentInitState,
        preserveExistingCheckpoints,
        assistantLanguage: resolvedLanguage,
        sourceOfTruth: resolvedSourceOfTruth,
        orchestratorVersion: bundleVersion,
        activeAgentFiles: resolvedActiveFiles,
        autoConfirmPrompts: true,
        autoAcceptRules: true
    }));

    // Best-effort stale task-event lock cleanup so reinit recovers provider state without reinstall.
    try {
        cleanupStaleTaskEventLocks(path.join(normalizedTarget, resolveBundleName()), { dryRun: false });
    } catch {
        // Ignore lock cleanup failures here; reinit still updates the workspace state and bundle surface.
    }

    const canonicalEntrypoint = getCanonicalEntrypointFile(resolvedSourceOfTruth);

    // Bundle invariant check (enforce consistency).
    const invariantResult = validateBundleInvariants(path.join(normalizedTarget, resolveBundleName()), expectedInvariantPaths);
    if (!invariantResult.isValid) {
        throw new Error(`Bundle invariant violation after reinit: ${invariantResult.violations.join('; ')}`);
    }
    writeProtectedControlPlaneManifest(normalizedTarget);

    return {
        targetRoot: normalizedTarget,
        initAnswersPath: resolvedInitPath,
        interactivePrompting: false,
        changes,
        assistantLanguage: resolvedLanguage,
        assistantBrevity: resolvedBrevity,
        sourceOfTruth: resolvedSourceOfTruth,
        canonicalEntrypoint,
        activeAgentFiles: resolvedActiveAgentFilesStr || 'n/a',
        enforceNoAutoCommit: resolvedEnforceNoAutoCommit,
        claudeOrchestratorFullAccess: resolvedClaudeOrchestratorFullAccess,
        tokenEconomyEnabled: resolvedTokenEconomyEnabled,
        providerMinimalism: resolvedProviderMinimalism,
        coreRuleUpdated,
        tokenEconomyConfigUpdated: tokenEconomyUpdated.updated,
        tokenEconomyConfigPath: tokenEconomyUpdated.path,
        verifyStatus: skipVerify ? 'SKIPPED' : 'NOT_RUN',
        manifestValidationStatus: skipManifestValidation ? 'SKIPPED' : 'NOT_RUN'
    };
    });
}

/**
 * Recollects init answers, applying overrides and preserving existing values.
 */
export function recollectInitAnswers(opts: RecollectInitAnswersOptions): RecollectedInitAnswers {
    const { existingAnswers, liveVersion, tokenEconomyConfig, overrides = {}, changes = [] } = opts;

    const schema = getInitAnswerSchema();
    const result: Record<string, string> = {};

    for (const def of schema) {
        const key = def.key;

        // Check override
        if (overrides[key] !== undefined && overrides[key] !== null && String(overrides[key]).trim()) {
            result[key] = String(overrides[key]).trim();
            changes.push({ key, action: 'overridden', value: result[key], source: 'cli_parameter', note: '' });
            continue;
        }

        // Check existing
        const existingVal = getOptionalValue(existingAnswers, key);
        if (existingVal) {
            result[key] = existingVal;
            changes.push({ key, action: 'preserved', value: result[key], source: 'existing_answers', note: '' });
            continue;
        }

        // Try infer from live version
        if (def.inferFrom) {
            for (const inference of def.inferFrom) {
                const source = inference.source === 'version.json' ? liveVersion
                    : inference.source === 'token-economy.json' ? tokenEconomyConfig : null;
                if (source) {
                    const val = getOptionalValue(source, inference.property);
                    if (val) {
                        result[key] = String(val);
                        changes.push({ key, action: 'inferred', value: result[key], source: inference.source, note: `from ${inference.property}` });
                        break;
                    }
                }
            }
            if (result[key] !== undefined) continue;
        }

        // Use default
        result[key] = def.defaultValue;
        changes.push({ key, action: 'recommended_default', value: result[key], source: 'schema_default', note: '' });
    }

    // Ensure CollectedVia
    if (!result.CollectedVia) {
        result.CollectedVia = 'CLI_NONINTERACTIVE';
    }

    return result as RecollectedInitAnswers;
}

function getInitAnswerSchema(): InitAnswerSchemaEntry[] {
    return [
        {
            key: 'AssistantLanguage',
            defaultValue: 'English',
            inferFrom: [{ source: 'version.json', property: 'AssistantLanguage' }]
        },
        {
            key: 'AssistantBrevity',
            defaultValue: 'concise',
            inferFrom: [{ source: 'version.json', property: 'AssistantBrevity' }]
        },
        {
            key: 'SourceOfTruth',
            defaultValue: 'Claude',
            inferFrom: [{ source: 'version.json', property: 'SourceOfTruth' }]
        },
        {
            key: 'EnforceNoAutoCommit',
            defaultValue: 'true',
            inferFrom: [{ source: 'version.json', property: 'EnforceNoAutoCommit' }]
        },
        {
            key: 'ClaudeOrchestratorFullAccess',
            defaultValue: 'false',
            inferFrom: [{ source: 'version.json', property: 'ClaudeOrchestratorFullAccess' }]
        },
        {
            key: 'TokenEconomyEnabled',
            defaultValue: 'true',
            inferFrom: [
                { source: 'version.json', property: 'TokenEconomyEnabled' },
                { source: 'token-economy.json', property: 'enabled' }
            ]
        },
        {
            key: 'ProviderMinimalism',
            defaultValue: 'true',
            inferFrom: [{ source: 'version.json', property: 'ProviderMinimalism' }]
        },
        {
            key: 'ActiveAgentFiles',
            defaultValue: '',
            inferFrom: [{ source: 'version.json', property: 'ActiveAgentFiles' }]
        },
        {
            key: 'CollectedVia',
            defaultValue: 'CLI_NONINTERACTIVE',
            inferFrom: null
        }
    ];
}

export function getOptionalValue(obj: Record<string, unknown> | null | undefined, key: string): string | null {
    if (!obj || typeof obj !== 'object') return null;
    // Case-insensitive lookup
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    for (const prop of Object.keys(obj)) {
        if (prop.toLowerCase().replace(/[_-]/g, '') === normalizedKey) {
            const val = obj[prop];
            if (val === null || val === undefined) return null;
            const str = String(val).trim();
            return str || null;
        }
    }
    return null;
}

/**
 * Updates the core rule file (00-core.md) with language/brevity values.
 */
export function updateCoreRuleFile(bundleRoot: string, sourceRoot: string, language: string, brevity: string): boolean {
    const livePath = path.join(bundleRoot, 'live/docs/agent-rules/00-core.md');
    const templatePath = path.join(sourceRoot, 'docs/agent-rules/00-core.md');

    const sourcePath = pathExists(livePath) ? livePath : pathExists(templatePath) ? templatePath : null;
    if (!sourcePath) {
        throw new Error(`Core rule source not found. Checked: ${livePath} and ${templatePath}`);
    }

    const content = readTextFile(sourcePath);
    if (!content || !content.trim()) {
        throw new Error(`Core rule source is empty: ${sourcePath}`);
    }

    const updatedContent = applyAssistantDefaults(content, '00-core.md', language, brevity);

    let existingContent = null;
    if (pathExists(livePath)) {
        existingContent = readTextFile(livePath);
    }

    if (existingContent === updatedContent) {
        return false;
    }

    ensureDirectory(path.dirname(livePath));
    fs.writeFileSync(livePath, updatedContent, 'utf8');
    return true;
}

/**
 * Updates the token economy config with the enabled flag.
 */
export function updateTokenEconomyConfig(
    bundleRoot: string,
    sourceRoot: string,
    enabled: boolean
): { updated: boolean; path: string } {
    const templatePath = path.join(sourceRoot, 'config/token-economy.json');
    const destPath = path.join(bundleRoot, 'live/config/token-economy.json');

    if (!pathExists(templatePath)) {
        throw new Error(`Token economy template config not found: ${templatePath}`);
    }

    const templateConfig = asObjectRecord(readJsonFile(templatePath));
    if (!templateConfig) {
        throw new Error(`Token economy template config must be a JSON object: ${templatePath}`);
    }
    let existingConfig: Record<string, unknown> | null = null;
    if (pathExists(destPath)) {
        try {
            existingConfig = asObjectRecord(readJsonFile(destPath));
        } catch {
            existingConfig = null;
        }
    }

    // Merge (simple for token economy)
    const merged: Record<string, unknown> = existingConfig
        ? JSON.parse(JSON.stringify(existingConfig)) as Record<string, unknown>
        : JSON.parse(JSON.stringify(templateConfig)) as Record<string, unknown>;
    merged.enabled = enabled;

    const json = JSON.stringify(merged, null, 2);
    let existingJson = null;
    if (pathExists(destPath)) {
        existingJson = readTextFile(destPath);
    }

    const updated = existingJson !== json;
    if (updated) {
        ensureDirectory(path.dirname(destPath));
        fs.writeFileSync(destPath, json, 'utf8');
    }

    return { updated, path: destPath };
}
