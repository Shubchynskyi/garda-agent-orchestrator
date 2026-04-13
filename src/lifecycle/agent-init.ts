import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';
import { validateInitAnswers, serializeInitAnswers } from '../schemas/init-answers';
import { convertActiveAgentEntrypointFilesToString, getActiveAgentEntrypointFiles } from '../materialization/common';
import { runInstall } from '../materialization/install';
import { runVerify } from '../validators/verify';
import { validateManifest } from '../validators/validate-manifest';
import { createAgentInitState, writeAgentInitState } from '../runtime/agent-init-state';

interface AgentInitState {
    OrchestratorVersion: string | null;
    AssistantLanguage: string | null;
    SourceOfTruth: string | null;
    AssistantLanguageConfirmed: boolean;
    ActiveAgentFilesConfirmed: boolean;
    ProjectRulesUpdated: boolean;
    SkillsPromptCompleted: boolean;
    VerificationPassed: boolean;
    ManifestValidationPassed: boolean;
    ActiveAgentFiles: string[];
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
    verifyResult: { passed: boolean };
    manifestResult: { passed: boolean };
    state: AgentInitState;
}

function resolvePathInsideTarget(targetRoot: string, relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(targetRoot, relativeOrAbsolutePath);
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
        installRunner = runInstall,
        verifyRunner = runVerify,
        manifestRunner = validateManifest
    } = options;

    const normalizedTargetRoot = path.resolve(targetRoot);
    const normalizedBundleRoot = path.resolve(bundleRoot);
    const resolvedInitAnswersPath = resolvePathInsideTarget(normalizedTargetRoot, initAnswersPath);
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
        VerificationPassed: verifyResult.passed,
        ManifestValidationPassed: manifestResult.passed,
        ActiveAgentFiles: normalizedActiveFiles
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
        readyForTasks: (
            state.AssistantLanguageConfirmed
            && state.ActiveAgentFilesConfirmed
            && state.ProjectRulesUpdated
            && state.SkillsPromptCompleted
            && state.VerificationPassed
            && state.ManifestValidationPassed
        ),
        verifyResult,
        manifestResult,
        state
    };
}
