import * as path from 'node:path';
import { resolveBundleNameForTarget, resolveInitAnswersRelativePathForTarget } from '../../core/constants';
import { runAgentInit } from '../../lifecycle/agent-init';
import { getStatusSnapshot } from '../../validators/status';
import { buildProfileAwareNextLine } from '../../validators/task-command';
import {
    buildAgentReportBlock,
    buildGuardedCommandHelpText,
    getAgentReportMessages
} from './cli-format-output';
import {
    bold,
    normalizePathValue,
    parseOptions,
    PackageJsonLike,
    printBanner,
    printStatus,
    resolveWorkspaceDisplayVersion
} from './cli-helpers';

export const AGENT_INIT_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
    '--active-agent-files': { key: 'activeAgentFiles', type: 'string' },
    '--project-rules-updated': { key: 'projectRulesUpdated', type: 'string' },
    '--skills-prompted': { key: 'skillsPrompted', type: 'string' },
    '--ordinary-doc-paths': { key: 'ordinaryDocPaths', type: 'string' }
};

export function buildAgentInitOutput(result: ReturnType<typeof runAgentInit>): string {
    const snapshot = getStatusSnapshot(result.targetRoot, result.initAnswersPath);
    const reportMessages = getAgentReportMessages();
    const lines: string[] = [];
    lines.push(buildAgentReportBlock({
        context: 'agent_init',
        assistantLanguage: snapshot.assistantLanguage,
        assistantLanguageConfirmed: snapshot.assistantLanguageConfirmed,
        profileSummary: snapshot.activeProfile,
        reviewModeSummary: reportMessages.summaries.mandatoryOrchestratorGates,
        optionalSkillsSummary: result.skillsPromptCompleted
            ? reportMessages.summaries.confirmedDuringAgentInit
            : reportMessages.summaries.pendingDuringAgentInit,
        mandatoryFullSuiteEnabled: snapshot.mandatoryFullSuiteEnabled,
        nextCommand: result.readyForTasks ? null : buildAgentInitNextStep(result),
        nextTaskPrompt: result.readyForTasks ? snapshot.recommendedNextCommand : null,
        latestUpdateNotice: snapshot.latestUpdateNotice
    }));
    lines.push('');
    lines.push(`Verify: ${result.verifyPassed ? 'PASS' : 'FAIL'}`);
    lines.push(`ManifestValidation: ${result.manifestPassed ? 'PASS' : 'FAIL'}`);
    lines.push(`ProjectRulesUpdated: ${result.projectRulesUpdated ? 'True' : 'False'}`);
    lines.push(`SkillsPromptCompleted: ${result.skillsPromptCompleted ? 'True' : 'False'}`);
    lines.push(`OrdinaryDocPaths: ${result.ordinaryDocPaths.length > 0 ? result.ordinaryDocPaths.join(', ') : 'none'}`);
    lines.push(`OrdinaryDocPathsDiscovered: ${result.ordinaryDocPathsDiscovered.length > 0 ? result.ordinaryDocPathsDiscovered.join(', ') : 'none'}`);
    lines.push(`OrdinaryDocPathsConfirmed: ${result.ordinaryDocPathsConfirmed ? 'True' : 'False'}`);
    lines.push(`OrdinaryDocPathsNeedsConfirmation: ${result.ordinaryDocPathsNeedsConfirmation ? 'True' : 'False'}`);
    lines.push(`OrdinaryDocPathsConfig: ${result.ordinaryDocPathsConfigPath}`);
    lines.push(`OrdinaryDocPathsEdit: ${result.ordinaryDocPathsEditHint}`);
    lines.push(`ActiveAgentFiles: ${result.activeAgentFiles.join(', ')}`);
    lines.push(`AgentInitStatePath: ${result.agentInitStatePath}`);
    lines.push(`AgentInit: ${result.readyForTasks ? 'PASS' : 'FAIL'}`);
    return lines.join('\n');
}

export function buildAgentInitNextStep(result: ReturnType<typeof runAgentInit>): string {
    if (result.readyForTasks) {
        return buildProfileAwareNextLine(result.bundleRoot || '');
    }

    const blockers: string[] = [];
    if (!result.projectRulesUpdated) {
        blockers.push('project rules are not marked as updated');
    }
    if (!result.skillsPromptCompleted) {
        blockers.push('specialist skills question is not marked as completed');
    }
    if (result.ordinaryDocPathsNeedsConfirmation) {
        blockers.push('ordinary document paths are not confirmed; rerun agent-init with --ordinary-doc-paths after user confirmation');
    }
    if (!result.verifyPassed) {
        blockers.push('verify failed');
    }
    if (!result.manifestPassed) {
        blockers.push('manifest validation failed');
    }

    return `Next: resolve blockers and rerun agent-init (${blockers.join('; ')})`;
}

export function handleAgentInit(commandArgv: string[], packageJson: PackageJsonLike): ReturnType<typeof runAgentInit> | null {
    const { options } = parseOptions(commandArgv, AGENT_INIT_DEFINITIONS);

    if (options.help) { console.log(buildGuardedCommandHelpText('agent-init')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    if (typeof options.activeAgentFiles !== 'string' || !options.activeAgentFiles.trim()) {
        throw new Error('--active-agent-files is required for agent-init.');
    }
    if (options.projectRulesUpdated === undefined) {
        throw new Error('--project-rules-updated is required for agent-init.');
    }
    if (options.skillsPrompted === undefined) {
        throw new Error('--skills-prompted is required for agent-init.');
    }

    const targetRoot = normalizePathValue(typeof options.targetRoot === 'string' ? options.targetRoot : '.');
    const bundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : path.join(targetRoot, resolveBundleNameForTarget(targetRoot));
    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : resolveInitAnswersRelativePathForTarget(targetRoot);

    console.log('GARDA_AGENT_INIT');
    printBanner(packageJson, 'Finalize agent onboarding', 'Runs install answer-dependent refresh, verify, manifest validation, and writes agent-init state.', {
        versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
    });

    const result = runAgentInit({
        targetRoot,
        bundleRoot,
        initAnswersPath,
        activeAgentFiles: options.activeAgentFiles,
        projectRulesUpdated: options.projectRulesUpdated,
        skillsPrompted: options.skillsPrompted,
        ordinaryDocPaths: options.ordinaryDocPaths
    });

    console.log(buildAgentInitOutput(result));
    console.log('');
    console.log(bold(buildAgentInitNextStep(result)));
    console.log('');
    printStatus(getStatusSnapshot(targetRoot, initAnswersPath), { heading: 'GARDA_AGENT_INIT_STATUS' });
    return result;
}
