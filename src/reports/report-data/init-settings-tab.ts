import * as path from 'node:path';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import { getCanonicalEntrypointFile } from '../../materialization/common';
import { ORDINARY_DOC_PATHS_CONFIG_KEY } from '../../core/ordinary-doc-paths';
import { pickRows, readJsonObjectForReport, toRepoRelativePath, valueRow } from './shared';
import type {
    ReportDataUnavailableEntry,
    ReportInitSettingsTab,
    ReportOrdinaryDocsInfo,
    ReportValueRow
} from './types';

function buildInitCommand(initAnswersPath: string): string {
    return [
        'garda reinit',
        '--target-root "."',
        `--init-answers-path "${initAnswersPath}"`
    ].join(' ');
}

function buildAgentInitPromptHandoff(): string {
    return 'Ask the agent: "Run the prompt from garda-agent-orchestrator/AGENT_INIT_PROMPT.md."';
}

function resolveCanonicalProviderFile(sourceOfTruth: unknown): string | null {
    if (!sourceOfTruth || !String(sourceOfTruth).trim()) {
        return null;
    }
    try {
        return getCanonicalEntrypointFile(String(sourceOfTruth));
    } catch {
        return null;
    }
}

function buildInitAnswerRows(root: string, source: Record<string, unknown>): ReportValueRow[] {
    const canonicalProviderFile = resolveCanonicalProviderFile(source.SourceOfTruth);
    return [
        valueRow('AssistantLanguage', 'Assistant language', 'Language the assistant should use with the operator.', source.AssistantLanguage),
        valueRow('AssistantBrevity', 'Assistant verbosity', 'How detailed normal assistant answers should be.', source.AssistantBrevity),
        valueRow(
            'SourceOfTruth',
            'Instruction owner',
            'Canonical provider file that owns generated agent instructions.',
            canonicalProviderFile
                ? `${String(source.SourceOfTruth || '').trim()} (${canonicalProviderFile})`
                : source.SourceOfTruth,
            canonicalProviderFile ? toRepoRelativePath(root, path.join(root, canonicalProviderFile)) : null
        ),
        valueRow('ActiveAgentFiles', 'Active agent files', 'Agent entrypoint files currently included in this project.', source.ActiveAgentFiles),
        valueRow('EnforceNoAutoCommit', 'No automatic commits', 'Prevents agents from committing without explicit operator approval (at least it tries).', source.EnforceNoAutoCommit),
        valueRow('ClaudeOrchestratorFullAccess', 'Claude full access mode', 'Whether Claude-oriented instructions assume full orchestrator access.', source.ClaudeOrchestratorFullAccess),
        valueRow('TokenEconomyEnabled', 'Token economy', 'Keeps generated instructions compact and avoids unnecessary context.', source.TokenEconomyEnabled),
        valueRow('ProviderMinimalism', 'Provider minimalism', 'Keeps non-canonical provider entrypoints as redirects when possible.', source.ProviderMinimalism)
    ];
}

function buildOrdinaryDocsInfo(
    root: string,
    pathsConfigPath: string,
    unavailable: ReportDataUnavailableEntry[]
): ReportOrdinaryDocsInfo {
    const localUnavailable: ReportDataUnavailableEntry[] = [];
    const pathsConfig = readJsonObjectForReport(root, pathsConfigPath, 'init-settings:paths-config', localUnavailable);
    unavailable.push(...localUnavailable);
    const rawPaths = pathsConfig.value[ORDINARY_DOC_PATHS_CONFIG_KEY];
    const paths = Array.isArray(rawPaths)
        ? rawPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
    return {
        config_path: toRepoRelativePath(root, pathsConfigPath),
        status: pathsConfig.status,
        paths,
        unavailable: localUnavailable
    };
}

export function buildInitSettingsTab(repoRoot: string): ReportInitSettingsTab {
    const root = path.resolve(repoRoot);
    const initAnswersPath = joinOrchestratorPath(root, path.join('runtime', 'init-answers.json'));
    const agentInitStatePath = joinOrchestratorPath(root, path.join('runtime', 'agent-init-state.json'));
    const pathsConfigPath = joinOrchestratorPath(root, path.join('live', 'config', 'paths.json'));
    const unavailable: ReportDataUnavailableEntry[] = [];
    const initAnswers = readJsonObjectForReport(root, initAnswersPath, 'init-settings:init-answers', unavailable);
    const agentState = readJsonObjectForReport(root, agentInitStatePath, 'init-settings:agent-init-state', unavailable);
    const initAnswersRelative = toRepoRelativePath(root, initAnswersPath);

    return {
        init_answers_path: initAnswersRelative,
        init_answers_status: initAnswers.status,
        init_answers: buildInitAnswerRows(root, initAnswers.value),
        agent_init_state_path: toRepoRelativePath(root, agentInitStatePath),
        agent_init_state_status: agentState.status,
        agent_init_state: pickRows(agentState.value, [
            ['OrchestratorVersion', 'Orchestrator version', 'Garda version that wrote the state.'],
            ['AssistantLanguageConfirmed', 'Language confirmed', 'Whether the assistant language checkpoint passed.'],
            ['ActiveAgentFilesConfirmed', 'Agent files confirmed', 'Whether selected active agent files were explicitly confirmed.'],
            ['ProjectRulesUpdated', 'Project rules updated', 'Whether project rules were reviewed or accepted during agent init.'],
            ['SkillsPromptCompleted', 'Skills prompted', 'Whether the skills prompt checkpoint completed.'],
            ['OrdinaryDocPathsConfirmed', 'Ordinary docs confirmed', 'Whether ordinary documentation paths were confirmed.'],
            ['VerificationPassed', 'Verification passed', 'Whether post-init verification passed.'],
            ['ManifestValidationPassed', 'Manifest valid', 'Whether protected control-plane manifest validation passed.'],
            ['LastSeededFullSuiteCommand', 'Seeded full-suite command', 'Test command seeded into workflow config during initialization.']
        ]),
        ordinary_docs: buildOrdinaryDocsInfo(root, pathsConfigPath, unavailable),
        commands: [
            {
                id: 'reinit',
                title: 'Re-initialize workspace',
                description: 'Re-materializes Garda generated files from the current init answers. Use it after changing initialization choices.',
                command: buildInitCommand(initAnswersRelative)
            },
            {
                id: 'agent-init',
                title: 'Agent prompt handoff',
                description: 'Give AGENT_INIT_PROMPT.md to the agent and ask it to complete the agent-init flow; the hard command only works after the agent has performed those checks.',
                command: buildAgentInitPromptHandoff()
            }
        ],
        unavailable
    };
}
