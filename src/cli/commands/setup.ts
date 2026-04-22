import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOURCE_OF_TRUTH_VALUES } from '../../core/constants';
import { buildSetupStartBannerSentence } from '../../core/orchestrator-start-banner';
import { pathExists, readTextFile } from '../../core/fs';
import { getActiveAgentEntrypointFiles } from '../../materialization/common';
import { getStatusSnapshot } from '../../validators/status';
import { readActiveProfileHint } from '../../validators/task-command';
import { buildLocalizedAgentReportBlock, resolveAgentReportLocale } from './cli-format-output';
import {
    acquireSourceRoot,
    bold,
    ensureDirectoryExists,
    getAgentInitPromptPath,
    getBundlePath,
    getInitAnswerValue,
    green,
    normalizeActiveAgentFiles,
    normalizeAssistantBrevity,
    normalizePathValue,
    normalizeSourceOfTruth,
    parseOptionalText,
    parseOptions,
    printBanner,
    printHelp,
    printHighlightedPair,
    printStatus,
    promptSingleSelect,
    promptTextInput,
    readOptionalJsonFile,
    resolveWorkspaceDisplayVersion,
    resolvePathInsideRoot,
    supportsInteractivePrompts,
    syncBundleItems,
    type PackageJsonLike,
    type StatusSnapshot,
    tryNormalizeAssistantBrevity,
    tryNormalizeSourceOfTruth,
    tryParseBooleanText
} from './cli-helpers';
import {
    buildRefreshAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../../runtime/agent-init-state';
import { withLifecycleOperationLockAsync } from '../../lifecycle/common';
import { runContractMigrations } from '../../lifecycle/contract-migrations';
import { serializeInitAnswers } from '../../schemas/init-answers';
import { runInstall } from '../../materialization/install';
import { runInit } from '../../materialization/init';
import { validateManifest } from '../../validators/validate-manifest';
import { runVerify } from '../../validators/verify';
import { writeProtectedControlPlaneManifest } from '../../gates/helpers';

// ---------------------------------------------------------------------------
// Flag definitions
// ---------------------------------------------------------------------------

export const SETUP_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
    '--repo-url': { key: 'repoUrl', type: 'string' },
    '--branch': { key: 'branch', type: 'string' },
    '--dry-run': { key: 'dryRun', type: 'boolean' },
    '--verify': { key: 'runVerify', type: 'boolean' },
    '--no-prompt': { key: 'noPrompt', type: 'boolean' },
    '--skip-verify': { key: 'skipVerify', type: 'boolean' },
    '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
    '--preserve-agent-state': { key: 'preserveAgentState', type: 'boolean' },
    '--assistant-language': { key: 'assistantLanguage', type: 'string' },
    '--assistant-brevity': { key: 'assistantBrevity', type: 'string' },
    '--active-agent-files': { key: 'activeAgentFiles', type: 'string' },
    '--source-of-truth': { key: 'sourceOfTruth', type: 'string' },
    '--enforce-no-auto-commit': { key: 'enforceNoAutoCommit', type: 'string' },
    '--claude-orchestrator-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
    '--claude-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
    '--token-economy-enabled': { key: 'tokenEconomyEnabled', type: 'string' },
    '--provider-minimalism': { key: 'providerMinimalism', type: 'string' }
};

interface SetupOptions {
    help?: boolean;
    version?: boolean;
    targetRoot?: string;
    initAnswersPath?: string;
    repoUrl?: string;
    branch?: string;
    dryRun?: boolean;
    runVerify?: boolean;
    noPrompt?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    preserveAgentState?: boolean;
    assistantLanguage?: string;
    assistantBrevity?: string;
    activeAgentFiles?: string;
    sourceOfTruth?: string;
    enforceNoAutoCommit?: string;
    claudeOrchestratorFullAccess?: string;
    tokenEconomyEnabled?: string;
    providerMinimalism?: string;
}

interface SetupAnswers {
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean | string;
    claudeOrchestratorFullAccess: boolean | string;
    tokenEconomyEnabled: boolean | string;
    providerMinimalism: boolean | string;
    activeAgentFiles: string | null;
}

// ---------------------------------------------------------------------------
// Setup answer defaults & interactive collection
// ---------------------------------------------------------------------------

function resolveSetupActiveAgentFiles(
    sourceOfTruth: string,
    explicitActiveAgentFiles: string | null | undefined,
    fallbackActiveAgentFiles?: unknown
): string | null {
    const candidateActiveAgentFiles = explicitActiveAgentFiles === undefined
        ? fallbackActiveAgentFiles
        : explicitActiveAgentFiles;
    return normalizeActiveAgentFiles(candidateActiveAgentFiles ?? null, sourceOfTruth);
}

export function getSetupAnswerDefaults(targetRoot: string, initAnswersPath: string, options: SetupOptions): SetupAnswers {
    const resolvedInitAnswersPath = resolvePathInsideRoot(targetRoot, initAnswersPath, 'InitAnswersPath', { allowMissing: true });
    const existingAnswers = readOptionalJsonFile(resolvedInitAnswersPath) || {};
    const sourceOfTruth = tryNormalizeSourceOfTruth(
        options.sourceOfTruth ?? getInitAnswerValue(existingAnswers, 'SourceOfTruth'),
        'Claude'
    );
    const activeAgentFiles = resolveSetupActiveAgentFiles(
        sourceOfTruth,
        options.activeAgentFiles,
        getInitAnswerValue(existingAnswers, 'ActiveAgentFiles')
    );

    return {
        assistantLanguage:
            parseOptionalText(options.assistantLanguage)
            || parseOptionalText(getInitAnswerValue(existingAnswers, 'AssistantLanguage'))
            || 'English',
        assistantBrevity: tryNormalizeAssistantBrevity(
            options.assistantBrevity ?? getInitAnswerValue(existingAnswers, 'AssistantBrevity'),
            'concise'
        ),
        sourceOfTruth,
        enforceNoAutoCommit: tryParseBooleanText(
            options.enforceNoAutoCommit ?? getInitAnswerValue(existingAnswers, 'EnforceNoAutoCommit'),
            true
        ),
        claudeOrchestratorFullAccess: tryParseBooleanText(
            options.claudeOrchestratorFullAccess ?? getInitAnswerValue(existingAnswers, 'ClaudeOrchestratorFullAccess'),
            false
        ),
        tokenEconomyEnabled: tryParseBooleanText(
            options.tokenEconomyEnabled ?? getInitAnswerValue(existingAnswers, 'TokenEconomyEnabled'),
            true
        ),
        providerMinimalism: tryParseBooleanText(
            options.providerMinimalism ?? getInitAnswerValue(existingAnswers, 'ProviderMinimalism'),
            true
        ),
        activeAgentFiles
    };
}

export async function collectSetupAnswersInteractively(
    targetRoot: string,
    initAnswersPath: string,
    options: SetupOptions
): Promise<SetupAnswers> {
    const defaults = getSetupAnswerDefaults(targetRoot, initAnswersPath, options);

    const assistantLanguage = await promptTextInput('Set communication language', defaults.assistantLanguage);
    const assistantBrevity = await promptSingleSelect({
        title: 'Set default response brevity',
        defaultLabel: defaults.assistantBrevity,
        defaultValue: defaults.assistantBrevity,
        options: [
            { label: 'concise', value: 'concise' },
            { label: 'detailed', value: 'detailed' }
        ]
    });
    const sourceOfTruth = await promptSingleSelect({
        title: 'Set primary source-of-truth entrypoint',
        defaultLabel: defaults.sourceOfTruth,
        defaultValue: defaults.sourceOfTruth,
        options: [...SOURCE_OF_TRUTH_VALUES].map(function (v) { return { label: v, value: v }; })
    });
    const enforceNoAutoCommit = await promptSingleSelect({
        title: 'Set no-auto-commit guard mode',
        defaultLabel: defaults.enforceNoAutoCommit ? 'Yes' : 'No',
        defaultValue: defaults.enforceNoAutoCommit ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });
    const claudeOrchestratorFullAccess = await promptSingleSelect({
        title: 'Set Claude access level for orchestrator files',
        defaultLabel: defaults.claudeOrchestratorFullAccess ? 'Yes' : 'No',
        defaultValue: defaults.claudeOrchestratorFullAccess ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });
    const tokenEconomyEnabled = await promptSingleSelect({
        title: 'Set default token economy mode',
        defaultLabel: defaults.tokenEconomyEnabled ? 'Yes' : 'No',
        defaultValue: defaults.tokenEconomyEnabled ? 'true' : 'false',
        options: [
            { label: 'No', value: 'false' },
            { label: 'Yes', value: 'true' }
        ]
    });

    const activeAgentFiles = resolveSetupActiveAgentFiles(sourceOfTruth, options.activeAgentFiles);

    return {
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism: defaults.providerMinimalism,
        activeAgentFiles
    };
}

// ---------------------------------------------------------------------------
// Setup handoff message
// ---------------------------------------------------------------------------

export function printSetupHandoff(snapshot: StatusSnapshot): void {
    console.log(buildSetupHandoffText(snapshot));
}

export function buildSetupHandoffText(snapshot: StatusSnapshot): string {
    const initPromptPath = getAgentInitPromptPath(snapshot.bundlePath);
    const gateFlow = 'enter-task-mode -> load-rule-pack -> handshake-diagnostics -> shell-smoke-preflight -> classify-change -> load-rule-pack -> compile-gate -> build-review-context (for each required review) -> required-reviews-check -> doc-impact-gate -> full-suite-validation (when enabled) -> completion-gate';
    const activeProfileHint = readActiveProfileHint(snapshot.bundlePath);
    const reportLocale = resolveAgentReportLocale(snapshot.assistantLanguage);
    const activeProfileSummary = activeProfileHint.activeProfile
        ? `${activeProfileHint.activeProfile} (default depth=${activeProfileHint.activeProfileDepth})`
        : null;
    const reviewModeSummary = reportLocale === 'ru'
        ? 'обязательные оркестраторные gate\'ы'
        : 'mandatory orchestrator gates';
    const optionalSkillsSummary = reportLocale === 'ru'
        ? 'уточнить в AGENT_INIT_PROMPT'
        : 'ask during AGENT_INIT_PROMPT';
    const activeProfileLine = activeProfileHint.activeProfile
        ? `Current active profile: ${activeProfileHint.activeProfile} (default depth=${activeProfileHint.activeProfileDepth}). Use explicit depth only as a one-run override.`
        : 'Use explicit depth only as a one-run override.';
    const lines = [
        buildLocalizedAgentReportBlock({
            context: 'setup_handoff',
            assistantLanguage: snapshot.assistantLanguage,
            assistantLanguageConfirmed: snapshot.assistantLanguageConfirmed,
            profileSummary: activeProfileSummary,
            reviewModeSummary,
            optionalSkillsSummary,
            mandatoryFullSuiteEnabled: snapshot.mandatoryFullSuiteEnabled,
            nextCommand: `Give your agent "${initPromptPath}"`,
            nextTaskPrompt: 'Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.',
            latestUpdateNotice: snapshot.latestUpdateNotice
        }),
        ''
    ];
    lines.push('');
    lines.push('Agent Initialization');
    lines.push('  Primary setup is complete.');
    lines.push('  Next stage: launch your agent and give it the init prompt.');
    if (snapshot.activeAgentFiles) {
        lines.push(`  Active agent files: ${snapshot.activeAgentFiles}`);
    }
    lines.push(`  1. Give your agent: "${initPromptPath}"`);
    lines.push('  2. The prompt already tells the agent to validate language,');
    lines.push('     explicitly confirm active agent files, update live project rules,');
    lines.push('     ask about specialist skills, and then run the code-level agent-init gate.');
    lines.push('  3. After the agent-init gate passes, start by picking a task row from TASK.md and telling the agent:');
    lines.push('     Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.');
    lines.push(`  4. ${buildSetupStartBannerSentence()}`);
    lines.push(`  5. ${activeProfileLine}`);
    lines.push('  6. Mandatory orchestrator flow:');
    lines.push(`     ${gateFlow}`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Setup banner builder (testable)
// ---------------------------------------------------------------------------

export function buildSetupStepsText(
    targetRoot: string,
    canUseInteractivePrompts: boolean,
    interactiveSetup: boolean
): string {
    const subtitle = canUseInteractivePrompts
        ? 'You will be asked 6 control questions.'
        : interactiveSetup
            ? 'Interactive prompts are unavailable in this terminal. Falling back to script-managed setup.'
            : 'Running in non-interactive mode with provided/default answers.';

    const lines = [];
    lines.push(`Subtitle: ${subtitle}`);
    lines.push(`Project: ${targetRoot}`);
    lines.push(`BundlePath: ${getBundlePath(targetRoot)}`);
    lines.push('');
    lines.push('Setup Steps');
    lines.push('  [1/3] Deploy bundle');
    lines.push('  [2/3] Collect or reuse init answers');
    lines.push('  [3/3] Run install and prepare agent handoff');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

/**
 * Handle the `setup` command.
 *
 * Contract markers:
 *   - GARDA_SETUP at the start
 *   - [1/3], [2/3], [3/3] step markers
 *   - GARDA_SETUP_STATUS after completion
 *   - Agent handoff message if agent init is incomplete
 *   - Exit code 0 on success
 */
export async function handleSetup(
    commandArgv: string[],
    packageJson: PackageJsonLike,
    packageRoot: string
): Promise<void> {
    const { options: parsedOptions } = parseOptions(commandArgv, SETUP_DEFINITIONS);
    const options = parsedOptions as SetupOptions;

    if (options.help) { printHelp(packageJson); return; }
    if (options.version) { console.log(packageJson.version); return; }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const interactiveSetup = !options.noPrompt;
    const canUseInteractivePrompts = interactiveSetup && supportsInteractivePrompts();

    console.log('GARDA_SETUP');
    printBanner(
        packageJson,
        'Primary setup',
        canUseInteractivePrompts
            ? 'You will be asked 6 control questions.'
            : interactiveSetup
                ? 'Interactive prompts are unavailable in this terminal. Falling back to script-managed setup.'
                : 'Running in non-interactive mode with provided/default answers.',
        { versionOverride: null }
    );
    console.log(`Project: ${targetRoot}`);
    console.log(`BundlePath: ${getBundlePath(targetRoot)}`);
    console.log('');
    console.log(bold('Setup Steps'));
    console.log(`  ${green('[1/3]')} Deploy bundle`);
    console.log(`  ${green('[2/3]')} Collect or reuse init answers`);
    console.log(`  ${green('[3/3]')} Run install and prepare agent handoff`);
    console.log('');

    const source = await acquireSourceRoot(options.repoUrl, options.branch, packageRoot);
    try {
        await withLifecycleOperationLockAsync(targetRoot, 'setup', async () => {
        const bundlePath = getBundlePath(targetRoot);
        const defaultInitAnswersPath = options.initAnswersPath || path.join(path.basename(bundlePath), 'runtime', 'init-answers.json');
        const promptedAnswers: SetupAnswers | null = canUseInteractivePrompts
            ? await collectSetupAnswersInteractively(
                targetRoot,
                defaultInitAnswersPath,
                options
            )
            : null;

        const sourceResolved = path.resolve(source.sourceRoot);
        const bundleResolved = path.resolve(bundlePath);
        if (sourceResolved.toLowerCase() !== bundleResolved.toLowerCase()) {
            if (fs.existsSync(bundlePath) && fs.lstatSync(bundlePath).isDirectory()) {
                syncBundleItems(source.sourceRoot, bundlePath);
            } else if (!options.dryRun) {
                syncBundleItems(source.sourceRoot, bundlePath);
            }
        }

        const effectiveBundlePath = fs.existsSync(bundlePath) ? bundlePath : source.sourceRoot;
        const initAnswersPath = defaultInitAnswersPath;
        const fallbackAnswers = getSetupAnswerDefaults(targetRoot, initAnswersPath, options);
        const resolvedAnswers = promptedAnswers || fallbackAnswers;
        const assistantLanguage = resolvedAnswers.assistantLanguage;
        const assistantBrevity = normalizeAssistantBrevity(resolvedAnswers.assistantBrevity);
        const sourceOfTruth = normalizeSourceOfTruth(resolvedAnswers.sourceOfTruth);
        const enforceNoAutoCommit = String(resolvedAnswers.enforceNoAutoCommit) === 'true';
        const claudeOrchestratorFullAccess = String(resolvedAnswers.claudeOrchestratorFullAccess) === 'true';
        const tokenEconomyEnabled = String(resolvedAnswers.tokenEconomyEnabled) === 'true';
        const providerMinimalism = String(resolvedAnswers.providerMinimalism) === 'true';
        const activeAgentFiles = resolveSetupActiveAgentFiles(
            sourceOfTruth,
            resolvedAnswers.activeAgentFiles
        ) || [];
        const collectedVia = promptedAnswers ? 'CLI_INTERACTIVE' : 'CLI_NONINTERACTIVE';
        const resolvedInitAnswersPath = resolvePathInsideRoot(targetRoot, initAnswersPath, 'InitAnswersPath', { allowMissing: true });
        const normalizedActiveAgentFiles = getActiveAgentEntrypointFiles(activeAgentFiles, sourceOfTruth);
        const previousAgentInitStateResult = readAgentInitStateSafe(targetRoot);
        const previousAgentInitState = previousAgentInitStateResult.state;
        const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {
            AssistantLanguage: assistantLanguage,
            SourceOfTruth: sourceOfTruth,
            ActiveAgentFiles: normalizedActiveAgentFiles
        });

        if (!options.dryRun) {
            const initAnswersDir = path.dirname(resolvedInitAnswersPath);
            if (!fs.existsSync(initAnswersDir)) {
                fs.mkdirSync(initAnswersDir, { recursive: true });
            }
            const serialized = serializeInitAnswers({
                AssistantLanguage: assistantLanguage,
                AssistantBrevity: assistantBrevity,
                SourceOfTruth: sourceOfTruth,
                EnforceNoAutoCommit: enforceNoAutoCommit,
                ClaudeOrchestratorFullAccess: claudeOrchestratorFullAccess,
                TokenEconomyEnabled: tokenEconomyEnabled,
                ProviderMinimalism: providerMinimalism,
                CollectedVia: collectedVia,
                ActiveAgentFiles: activeAgentFiles
            });
            fs.writeFileSync(resolvedInitAnswersPath, JSON.stringify(serialized, null, 2), 'utf8');
        }

        runInstall({
            targetRoot,
            bundleRoot: effectiveBundlePath,
            assistantLanguage,
            assistantBrevity,
            sourceOfTruth,
            initAnswersPath: resolvedInitAnswersPath,
            dryRun: options.dryRun,
            initRunner: function (initOptions: Omit<Parameters<typeof runInit>[0], 'bundleRoot'>) {
                runInit(Object.assign({ bundleRoot: effectiveBundlePath }, initOptions));
            }
        });

        if (!options.dryRun) {
            runContractMigrations({ rootPath: targetRoot });
            writeProtectedControlPlaneManifest(targetRoot);
        }

        let manifestStatus = options.skipManifestValidation ? 'SKIPPED' : 'PASS';
        if (!options.skipManifestValidation) {
            try {
                const manifestPath = path.join(effectiveBundlePath, 'MANIFEST.md');
                const manifestResult = validateManifest(manifestPath, targetRoot);
                manifestStatus = manifestResult.passed ? 'PASS' : 'FAIL';
            } catch (_error) {
                manifestStatus = 'ERROR';
            }
        }

        let snapshot = getStatusSnapshot(targetRoot, initAnswersPath) as StatusSnapshot;
        let verifyStatus = options.skipVerify ? 'SKIPPED' : 'PENDING_AGENT_CONTEXT';
        if (!options.skipVerify) {
            try {
                if (snapshot.readyForTasks || options.runVerify || options.preserveAgentState) {
                    const verifyResult = runVerify({
                        targetRoot,
                        sourceOfTruth,
                        initAnswersPath: resolvedInitAnswersPath
                    });
                    verifyStatus = verifyResult.totalViolationCount > 0 ? 'FAIL' : 'PASS';
                }
            } catch (_error) {
                verifyStatus = 'PENDING_AGENT_CONTEXT';
            }
        }

        const bundleVersionPath = path.join(effectiveBundlePath, 'VERSION');
        const bundleVersion = pathExists(bundleVersionPath)
            ? (readTextFile(bundleVersionPath).trim() || null)
            : null;

        if (!options.dryRun) {
            writeAgentInitState(targetRoot, buildRefreshAgentInitState({
                previousState: previousAgentInitState,
                preserveExistingCheckpoints,
                assistantLanguage,
                sourceOfTruth,
                orchestratorVersion: bundleVersion,
                activeAgentFiles: normalizedActiveAgentFiles,
                verificationPassed: options.skipVerify ? null : verifyStatus === 'PASS',
                manifestValidationPassed: options.skipManifestValidation ? null : manifestStatus === 'PASS',
                autoConfirmPrompts: options.preserveAgentState === true,
                autoAcceptRules: options.preserveAgentState === true
            }));
            snapshot = getStatusSnapshot(targetRoot, initAnswersPath) as StatusSnapshot;
        }

        console.log(`Setup: ${manifestStatus === 'FAIL' ? 'FAIL' : 'PASS'}`);
        console.log(`Verify: ${verifyStatus}`);
        console.log(`ManifestValidation: ${manifestStatus}`);
        console.log('');
        printBanner(
            packageJson,
            'Setup complete',
            snapshot.readyForTasks
                ? 'Workspace is ready.'
                : 'Primary setup finished. Next stage: agent initialization.',
            { versionOverride: bundleVersion || resolveWorkspaceDisplayVersion(targetRoot, packageJson.version) }
        );
        printStatus(snapshot, { heading: 'GARDA_SETUP_STATUS' });
        if (!snapshot.agentInitializationComplete) {
            printSetupHandoff(snapshot);
        }
        });
    } finally {
        source.cleanup();
    }
}
