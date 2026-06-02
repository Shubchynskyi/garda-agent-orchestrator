import * as path from 'node:path';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import { pickRows, readJsonObjectForReport, toRepoRelativePath } from './shared';
import type { ReportDataUnavailableEntry, ReportInitSettingsTab } from './types';

function buildInitCommand(initAnswersPath: string): string {
    return [
        'garda reinit',
        '--target-root "."',
        `--init-answers-path "${initAnswersPath}"`
    ].join(' ');
}

function buildAgentInitCommand(initAnswersPath: string, activeAgentFiles: unknown): string {
    const activeFiles = String(activeAgentFiles || '<active-agent-files>');
    return [
        'garda agent-init',
        '--target-root "."',
        `--init-answers-path "${initAnswersPath}"`,
        `--active-agent-files "${activeFiles}"`,
        '--project-rules-updated yes',
        '--skills-prompted yes'
    ].join(' ');
}

export function buildInitSettingsTab(repoRoot: string): ReportInitSettingsTab {
    const root = path.resolve(repoRoot);
    const initAnswersPath = joinOrchestratorPath(root, path.join('runtime', 'init-answers.json'));
    const agentInitStatePath = joinOrchestratorPath(root, path.join('runtime', 'agent-init-state.json'));
    const unavailable: ReportDataUnavailableEntry[] = [];
    const initAnswers = readJsonObjectForReport(root, initAnswersPath, 'init-settings:init-answers', unavailable);
    const agentState = readJsonObjectForReport(root, agentInitStatePath, 'init-settings:agent-init-state', unavailable);
    const initAnswersRelative = toRepoRelativePath(root, initAnswersPath);
    const activeAgentFiles = agentState.value.ActiveAgentFiles || initAnswers.value.ActiveAgentFiles;

    return {
        init_answers_path: initAnswersRelative,
        init_answers_status: initAnswers.status,
        init_answers: pickRows(initAnswers.value, [
            ['AssistantLanguage', 'Assistant language', 'Language the assistant should use with the operator.'],
            ['AssistantBrevity', 'Assistant verbosity', 'How detailed normal assistant answers should be.'],
            ['SourceOfTruth', 'Instruction owner', 'Canonical provider file that owns generated agent instructions.'],
            ['EnforceNoAutoCommit', 'No automatic commits', 'Prevents agents from committing without explicit operator approval.'],
            ['ClaudeOrchestratorFullAccess', 'Claude full access mode', 'Whether Claude-oriented instructions assume full orchestrator access.'],
            ['TokenEconomyEnabled', 'Token economy', 'Keeps generated instructions compact and avoids unnecessary context.'],
            ['ProviderMinimalism', 'Provider minimalism', 'Keeps non-canonical provider entrypoints as redirects when possible.'],
            ['CollectedVia', 'Collected via', 'How the init answers were collected.'],
            ['ActiveAgentFiles', 'Active agent files', 'Root/provider instruction files selected during initialization.']
        ]),
        agent_init_state_path: toRepoRelativePath(root, agentInitStatePath),
        agent_init_state_status: agentState.status,
        agent_init_state: pickRows(agentState.value, [
            ['UpdatedAt', 'Last updated', 'When the hard agent-init state was last written.'],
            ['OrchestratorVersion', 'Orchestrator version', 'Garda version that wrote the state.'],
            ['AssistantLanguageConfirmed', 'Language confirmed', 'Whether the assistant language checkpoint passed.'],
            ['ActiveAgentFilesConfirmed', 'Agent files confirmed', 'Whether selected active agent files were explicitly confirmed.'],
            ['ProjectRulesUpdated', 'Project rules updated', 'Whether project rules were reviewed or accepted during agent init.'],
            ['SkillsPromptCompleted', 'Skills prompted', 'Whether the skills prompt checkpoint completed.'],
            ['OrdinaryDocPathsConfirmed', 'Ordinary docs confirmed', 'Whether ordinary documentation paths were confirmed.'],
            ['OrdinaryDocPaths', 'Ordinary docs', 'User-owned documentation paths Garda may mention without treating them as generated rules.'],
            ['VerificationPassed', 'Verification passed', 'Whether post-init verification passed.'],
            ['ManifestValidationPassed', 'Manifest valid', 'Whether protected control-plane manifest validation passed.'],
            ['ActiveAgentFiles', 'Active agent files', 'Canonical files active after agent init.'],
            ['LastSeededFullSuiteCommand', 'Seeded full-suite command', 'Test command seeded into workflow config during initialization.'],
            ['ProjectMemoryInitialized', 'Project memory initialized', 'Whether agent-init recorded project-memory initialization.'],
            ['ProjectMemoryValidated', 'Project memory validated', 'Whether agent-init recorded successful project-memory validation.'],
            ['ProjectMemoryMode', 'Project memory mode', 'Project-memory bootstrap mode recorded by agent init.'],
            ['ProjectMemoryDir', 'Project memory directory', 'Directory that contains durable project memory.'],
            ['ProjectMemoryReadFirst', 'Project memory read-first files', 'Files agents should read before focused memory files.'],
            ['ProjectMemorySummaryRule', 'Project memory summary rule', 'Generated rule file that summarizes project memory.'],
            ['ProjectMemoryBootstrapReport', 'Project memory bootstrap report', 'Runtime report from project-memory bootstrap.'],
            ['ProjectMemoryWarnings', 'Project memory warnings', 'Warnings recorded during project-memory bootstrap or validation.']
        ]),
        commands: [
            {
                id: 'reinit',
                title: 'Re-initialize workspace',
                description: 'Re-materializes Garda generated files from the current init answers. Use it after changing initialization choices.',
                command: buildInitCommand(initAnswersRelative)
            },
            {
                id: 'agent-init',
                title: 'Complete agent initialization',
                description: 'Records the hard onboarding checkpoints, active agent files, project-rule confirmation, skills prompt, and project-memory readiness.',
                command: buildAgentInitCommand(initAnswersRelative, activeAgentFiles)
            }
        ],
        unavailable
    };
}
