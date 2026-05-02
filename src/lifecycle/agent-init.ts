import * as path from 'node:path';
import {
    LEGACY_FULL_SUITE_VALIDATION_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    resolveBundleName
} from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
import { readJsonFile, writeJsonFile } from '../core/json';
import { isPlainObject } from '../core/config-merge';
import { getWorkflowConfigPath, syncWorkflowConfigWithTemplate } from '../core/workflow-config';
import { validateInitAnswers, serializeInitAnswers } from '../schemas/init-answers';
import { convertActiveAgentEntrypointFilesToString, getActiveAgentEntrypointFiles } from '../materialization/common';
import { resolveSuggestedFullSuiteValidationCommand } from '../materialization/project-discovery';
import { runInstall } from '../materialization/install';
import { runVerify } from '../validators/verify';
import { validateManifest } from '../validators/validate-manifest';
import { createAgentInitState, readAgentInitStateSafe, writeAgentInitState } from '../runtime/agent-init-state';
import {
    DEFAULT_ORDINARY_DOC_PATHS,
    ORDINARY_DOC_PATHS_CONFIG_KEY,
    normalizeOrdinaryDocPathPatterns,
    parseOrdinaryDocPathList
} from '../core/ordinary-doc-paths';

interface AgentInitState {
    OrchestratorVersion: string | null;
    AssistantLanguage: string | null;
    SourceOfTruth: string | null;
    AssistantLanguageConfirmed: boolean;
    ActiveAgentFilesConfirmed: boolean;
    ProjectRulesUpdated: boolean;
    SkillsPromptCompleted: boolean;
    OrdinaryDocPathsConfirmed: boolean;
    OrdinaryDocPaths: string[];
    VerificationPassed: boolean;
    ManifestValidationPassed: boolean;
    ActiveAgentFiles: string[];
    LastSeededFullSuiteCommand: string | null;
}

interface AgentInitInstallOptions {
    targetRoot: string;
    bundleRoot: string;
    preserveExisting: boolean;
    alignExisting: boolean;
    runInit: boolean;
    answerDependentOnly: boolean;
    skipBackups: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface AgentInitVerifyOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

interface RunAgentInitOptions {
    targetRoot: string;
    bundleRoot?: string;
    initAnswersPath?: string;
    activeAgentFiles: string | string[] | null | undefined;
    projectRulesUpdated: unknown;
    skillsPrompted: unknown;
    ordinaryDocPaths?: unknown;
    installRunner?: (options: AgentInitInstallOptions) => void;
    verifyRunner?: (options: AgentInitVerifyOptions) => { passed: boolean };
    manifestRunner?: (manifestPath: string) => { passed: boolean };
}

export interface AgentInitResult {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath: string;
    agentInitStatePath: string;
    activeAgentFiles: string[];
    projectRulesUpdated: boolean;
    skillsPromptCompleted: boolean;
    verifyPassed: boolean;
    manifestPassed: boolean;
    readyForTasks: boolean;
    ordinaryDocPaths: string[];
    ordinaryDocPathsDiscovered: string[];
    ordinaryDocPathsConfirmed: boolean;
    ordinaryDocPathsNeedsConfirmation: boolean;
    ordinaryDocPathsPersisted: boolean;
    ordinaryDocPathsConfigPath: string;
    ordinaryDocPathsEditHint: string;
    verifyResult: { passed: boolean };
    manifestResult: { passed: boolean };
    state: AgentInitState;
}

function normalizeOptionalCommand(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function seedWorkflowConfigFullSuiteCommand(
    targetRoot: string,
    bundleRoot: string,
    previousState: AgentInitState | null
): string | null {
    const detectedCommand = resolveSuggestedFullSuiteValidationCommand(targetRoot)
        || UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND;
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const rawConfig = syncWorkflowConfigWithTemplate(bundleRoot, {
        preserveLegacyReviewExecutionPolicyOmission: true
    });

    const existingSection = isPlainObject(rawConfig.full_suite_validation)
        ? rawConfig.full_suite_validation as Record<string, unknown>
        : {};
    const currentCommand = normalizeOptionalCommand(existingSection.command);
    const previousSeededCommand = normalizeOptionalCommand(previousState?.LastSeededFullSuiteCommand);
    const shouldReplaceCommand = !currentCommand
        || currentCommand === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
        || (previousSeededCommand !== null && currentCommand === previousSeededCommand)
        || (
            previousSeededCommand === null
            && currentCommand === LEGACY_FULL_SUITE_VALIDATION_COMMAND
            && detectedCommand !== LEGACY_FULL_SUITE_VALIDATION_COMMAND
        );

    const nextCommand = shouldReplaceCommand ? detectedCommand : currentCommand;
    const nextConfig = {
        ...rawConfig,
        full_suite_validation: {
            ...existingSection,
            enabled: existingSection.enabled === true,
            command: nextCommand,
        }
    };

    const nextSeededCommand = shouldReplaceCommand ? detectedCommand : previousSeededCommand;
    writeJsonFile(workflowConfigPath, nextConfig);
    return nextSeededCommand;
}

function resolvePathInsideTarget(targetRoot: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(targetRoot, relativeOrAbsolutePath);
}

function discoverOrdinaryDocPathCandidates(targetRoot: string): string[] {
    const candidates = [
        ...DEFAULT_ORDINARY_DOC_PATHS,
        'docs/plan.md',
        'docs/planning.md',
        'docs/roadmap.md',
        'docs/todo.md',
        'docs/backlog.md',
        'PLAN.md',
        'ROADMAP.md',
        'TODO.md',
        'BACKLOG.md',
        'NOTES.md'
    ];
    const discovered = candidates.filter((candidate) => (
        DEFAULT_ORDINARY_DOC_PATHS.includes(candidate)
        || pathExists(path.join(targetRoot, candidate))
    ));
    return normalizeOrdinaryDocPathPatterns(discovered, ORDINARY_DOC_PATHS_CONFIG_KEY);
}

function readPathsConfig(pathsConfigPath: string): Record<string, unknown> {
    if (!pathExists(pathsConfigPath)) {
        return {};
    }
    const parsed = readJsonFile(pathsConfigPath);
    return isPlainObject(parsed) ? parsed as Record<string, unknown> : {};
}

function syncOrdinaryDocPathsConfig(
    targetRoot: string,
    bundleRoot: string,
    ordinaryDocPathsOption: unknown,
    previousState: AgentInitState | null
): {
    paths: string[];
    discovered: string[];
    confirmed: boolean;
    needsConfirmation: boolean;
    persisted: boolean;
    configPath: string;
    editHint: string;
} {
    const pathsConfigPath = path.join(bundleRoot, 'live', 'config', 'paths.json');
    const discovered = discoverOrdinaryDocPathCandidates(targetRoot);
    const rawConfig = readPathsConfig(pathsConfigPath);
    const hasConfirmedOption = ordinaryDocPathsOption !== undefined && ordinaryDocPathsOption !== null;
    const hasConfiguredKey = rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY] !== undefined;
    const previousConfirmed = previousState?.OrdinaryDocPathsConfirmed === true;
    const existingPaths = rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY] === undefined
        ? []
        : normalizeOrdinaryDocPathPatterns(
            rawConfig[ORDINARY_DOC_PATHS_CONFIG_KEY],
            `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
            { allowScalar: true }
        );
    let paths: string[];
    if (hasConfirmedOption) {
        paths = parseOrdinaryDocPathList(ordinaryDocPathsOption, ORDINARY_DOC_PATHS_CONFIG_KEY);
    } else if (previousConfirmed && hasConfiguredKey) {
        paths = existingPaths;
    } else if (previousConfirmed) {
        paths = previousState!.OrdinaryDocPaths;
    } else {
        paths = hasConfiguredKey ? existingPaths : discovered;
    }

    const confirmed = hasConfirmedOption || previousConfirmed;
    const needsConfirmation = !confirmed;

    let persisted = false;
    if (hasConfirmedOption || (previousConfirmed && !hasConfiguredKey)) {
        writeJsonFile(pathsConfigPath, {
            ...rawConfig,
            [ORDINARY_DOC_PATHS_CONFIG_KEY]: paths
        });
        persisted = true;
    }

    return {
        paths,
        discovered,
        confirmed,
        needsConfirmation,
        persisted,
        configPath: pathsConfigPath,
        editHint: `Edit ${path.join('garda-agent-orchestrator', 'live', 'config', 'paths.json')} field ${ORDINARY_DOC_PATHS_CONFIG_KEY}.`
    };
}

function parseBooleanYesNo(value: unknown, fieldName: string): boolean {
    if (value === true || value === false) {
        return value;
    }

    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'yes' || normalized === 'true' || normalized === '1') {
        return true;
    }
    if (normalized === 'no' || normalized === 'false' || normalized === '0') {
        return false;
    }
    throw new Error(`${fieldName} must be yes or no.`);
}

export function runAgentInit(options: RunAgentInitOptions): AgentInitResult {
    const {
        targetRoot,
        bundleRoot = path.join(targetRoot, resolveBundleName()),
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        activeAgentFiles,
        projectRulesUpdated,
        skillsPrompted,
        ordinaryDocPaths,
        installRunner = runInstall,
        verifyRunner = runVerify,
        manifestRunner = validateManifest
    } = options;

    const normalizedTargetRoot = path.resolve(targetRoot);
    const normalizedBundleRoot = path.resolve(bundleRoot);
    const resolvedInitAnswersPath = resolvePathInsideTarget(normalizedTargetRoot, initAnswersPath);
    const previousState = readAgentInitStateSafe(normalizedTargetRoot).state as AgentInitState | null;
    const bundleVersionPath = path.join(normalizedBundleRoot, 'VERSION');
    const orchestratorVersion = pathExists(bundleVersionPath)
        ? (readTextFile(bundleVersionPath).trim() || null)
        : null;

    if (!pathExists(normalizedBundleRoot)) {
        throw new Error(`Deployed bundle not found: ${normalizedBundleRoot}`);
    }
    if (!pathExists(resolvedInitAnswersPath)) {
        throw new Error(`Init answers artifact not found: ${resolvedInitAnswersPath}`);
    }

    const answers = validateInitAnswers(readJsonFile(resolvedInitAnswersPath));
    const normalizedActiveFiles = getActiveAgentEntrypointFiles(activeAgentFiles, answers.SourceOfTruth);
    if (normalizedActiveFiles.length === 0) {
        throw new Error('ActiveAgentFiles must resolve to at least one canonical entrypoint.');
    }

    const serializedAnswers = serializeInitAnswers({
        ...answers,
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: convertActiveAgentEntrypointFilesToString(normalizedActiveFiles)
    });
    writeJsonFile(resolvedInitAnswersPath, serializedAnswers);

    installRunner({
        targetRoot: normalizedTargetRoot,
        bundleRoot: normalizedBundleRoot,
        preserveExisting: true,
        alignExisting: true,
        runInit: false,
        answerDependentOnly: true,
        skipBackups: true,
        assistantLanguage: serializedAnswers.AssistantLanguage,
        assistantBrevity: serializedAnswers.AssistantBrevity,
        sourceOfTruth: serializedAnswers.SourceOfTruth,
        initAnswersPath: resolvedInitAnswersPath
    });

    const seededFullSuiteCommand = seedWorkflowConfigFullSuiteCommand(
        normalizedTargetRoot,
        normalizedBundleRoot,
        previousState
    );
    const ordinaryDocPathsResult = syncOrdinaryDocPathsConfig(
        normalizedTargetRoot,
        normalizedBundleRoot,
        ordinaryDocPaths,
        previousState
    );

    const verifyResult = verifyRunner({
        targetRoot: normalizedTargetRoot,
        sourceOfTruth: serializedAnswers.SourceOfTruth,
        initAnswersPath: resolvedInitAnswersPath
    });
    const manifestResult = manifestRunner(path.join(normalizedBundleRoot, 'MANIFEST.md'));

    const state = createAgentInitState({
        OrchestratorVersion: orchestratorVersion,
        AssistantLanguage: serializedAnswers.AssistantLanguage,
        SourceOfTruth: serializedAnswers.SourceOfTruth,
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: parseBooleanYesNo(projectRulesUpdated, 'ProjectRulesUpdated'),
        SkillsPromptCompleted: parseBooleanYesNo(skillsPrompted, 'SkillsPrompted'),
        OrdinaryDocPathsConfirmed: ordinaryDocPathsResult.confirmed,
        OrdinaryDocPaths: ordinaryDocPathsResult.confirmed ? ordinaryDocPathsResult.paths : [],
        VerificationPassed: verifyResult.passed,
        ManifestValidationPassed: manifestResult.passed,
        ActiveAgentFiles: normalizedActiveFiles,
        LastSeededFullSuiteCommand: seededFullSuiteCommand
    }) as AgentInitState;
    const statePath = writeAgentInitState(normalizedTargetRoot, state);

    return {
        targetRoot: normalizedTargetRoot,
        bundleRoot: normalizedBundleRoot,
        initAnswersPath: resolvedInitAnswersPath,
        agentInitStatePath: statePath,
        activeAgentFiles: normalizedActiveFiles,
        projectRulesUpdated: state.ProjectRulesUpdated,
        skillsPromptCompleted: state.SkillsPromptCompleted,
        verifyPassed: verifyResult.passed,
        manifestPassed: manifestResult.passed,
        ordinaryDocPaths: ordinaryDocPathsResult.paths,
        ordinaryDocPathsDiscovered: ordinaryDocPathsResult.discovered,
        ordinaryDocPathsConfirmed: ordinaryDocPathsResult.confirmed,
        ordinaryDocPathsNeedsConfirmation: ordinaryDocPathsResult.needsConfirmation,
        ordinaryDocPathsPersisted: ordinaryDocPathsResult.persisted,
        ordinaryDocPathsConfigPath: ordinaryDocPathsResult.configPath,
        ordinaryDocPathsEditHint: ordinaryDocPathsResult.editHint,
        readyForTasks: (
            state.AssistantLanguageConfirmed
            && state.ActiveAgentFilesConfirmed
            && state.ProjectRulesUpdated
            && state.SkillsPromptCompleted
            && state.OrdinaryDocPathsConfirmed
            && state.VerificationPassed
            && state.ManifestValidationPassed
        ),
        verifyResult,
        manifestResult,
        state
    };
}
