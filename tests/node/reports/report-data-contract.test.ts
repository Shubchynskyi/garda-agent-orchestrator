import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import {
    buildReportDataContract,
    buildWorkflowConfigTab,
    readCanonicalActiveQueueRows
} from '../../../src/reports/report-data-contract';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-report-data-'));
}

function writeTaskMd(repoRoot: string, extraContent = ''): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | 🟨 IN_PROGRESS | P2 | ui/report | Build report data | gpt-5.4 | 2026-05-16 | balanced | Uses logs only |',
        '| T-101 | 🟦 TODO | P2 | ui/report | Build HTML | gpt-5.4 | 2026-05-16 | balanced | Next task |',
        '',
        extraContent
    ].join('\n'));
}

function writeWorkflowConfig(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = true;
    config.full_suite_validation.command = 'npm test';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function writeInitAndProjectMemory(repoRoot: string): void {
    const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'Russian',
        AssistantBrevity: 'detailed',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'true',
        TokenEconomyEnabled: 'true',
        ProviderMinimalism: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2));
    fs.writeFileSync(path.join(runtimeRoot, 'agent-init-state.json'), JSON.stringify({
        Version: 1,
        UpdatedAt: '2026-05-16T00:00:00.000Z',
        OrchestratorVersion: '1.1.0',
        AssistantLanguage: 'Russian',
        SourceOfTruth: 'Codex',
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: true,
        SkillsPromptCompleted: true,
        OrdinaryDocPathsConfirmed: true,
        OrdinaryDocPaths: ['CHANGELOG.md'],
        VerificationPassed: true,
        ManifestValidationPassed: true,
        ActiveAgentFiles: ['AGENTS.md'],
        LastSeededFullSuiteCommand: 'npm test',
        ProjectMemoryInitialized: true,
        ProjectMemoryValidated: true,
        ProjectMemoryMode: 'strict',
        ProjectMemoryDir: 'live/docs/project-memory',
        ProjectMemoryReadFirst: [
            'live/docs/project-memory/README.md',
            'live/docs/project-memory/compact.md'
        ],
        ProjectMemorySummaryRule: 'live/docs/agent-rules/15-project-memory.md',
        ProjectMemoryBootstrapReport: 'runtime/project-memory/bootstrap-report.json',
        ProjectMemoryWarnings: []
    }, null, 2));
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of ['README.md', 'compact.md', 'context.md', 'stack.md', 'architecture.md', 'module-map.md', 'commands.md', 'conventions.md', 'decisions.md', 'risks.md']) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nMemory for ${fileName}.\n`);
    }
}

test('readCanonicalActiveQueueRows reads only the canonical upper Active Queue table', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot, [
        '## User Summary (RU)',
        '| ID | Summary |',
        '|---|---|',
        '| T-999 | Must not become a task row |',
        '| T-100 | Must not overwrite the canonical title |'
    ].join('\n'));

    const result = readCanonicalActiveQueueRows(repoRoot);

    assert.deepEqual(result.rows.map((row) => row.task_id), ['T-100', 'T-101']);
    assert.equal(result.rows[0].status_token, 'IN_PROGRESS');
    assert.equal(result.rows[0].title, 'Build report data');
    assert.equal(result.unavailable.length, 0);
});

test('buildWorkflowConfigTab exposes read-only settings with commands and descriptions', () => {
    const repoRoot = makeTempRepo();
    writeWorkflowConfig(repoRoot);

    const tab = buildWorkflowConfigTab(repoRoot);

    assert.equal(tab.status, 'present');
    assert.equal(tab.config_exists, true);
    assert.ok(tab.settings.length > 0);
    const fullSuite = tab.settings.find((setting) => setting.key === 'full_suite_validation.enabled');
    assert.ok(fullSuite);
    assert.equal(fullSuite.value, true);
    assert.equal(fullSuite.readonly, true);
    assert.equal(fullSuite.label, 'Mandatory full-suite validation');
    assert.equal(fullSuite.value_type, 'boolean');
    assert.ok(fullSuite.options.some((option) => option.value === 'true'));
    assert.match(fullSuite.command, /garda workflow set --full-suite-enabled <true\|false>/);
    assert.match(fullSuite.description, /full-suite/i);
    const selfGuard = tab.settings.find((setting) => setting.key === 'orchestrator_work_policy.mode');
    assert.ok(selfGuard);
    assert.match(selfGuard.command, /garda workflow set --garda-self-guard <on\|off>/);
    assert.doesNotMatch(selfGuard.command, /deny_agent_entry\|require_operator_confirmation/);
});

test('buildReportDataContract exposes tasks, workflow config, and instruction tabs', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    assert.equal(report.schema_version, 1);
    assert.equal(report.generated_at_utc, '2026-05-16T00:00:00.000Z');
    assert.equal(report.tasks_tab.parser, 'canonical_active_queue_9_columns');
    assert.deepEqual(report.tasks_tab.rows.map((row) => row.task_id), ['T-100', 'T-101']);
    assert.equal(report.tasks_tab.rows[0].detail.detail_status, 'skipped');
    assert.equal(report.workflow_config_tab.status, 'present');
    assert.equal(report.init_settings_tab.init_answers_status, 'present');
    assert.equal(report.init_settings_tab.agent_init_state_status, 'present');
    assert.ok(report.init_settings_tab.commands.some((command) => command.id === 'reinit'));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-mode' && row.value === 'update'));
    assert.ok(report.project_memory_tab.files.some((file) => file.path.endsWith('project-memory/compact.md') && file.content?.includes('Memory for compact.md')));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Task execution'));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Review execution modes'));
    assert.ok(report.tasks_tab.rows[0].detail.unavailable.some((entry) => entry.scope === 'task:T-100:detail'));
    assert.equal(report.unavailable.length, 0);
});

test('buildReportDataContract bounds deep task detail collection', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        maxDetailedTasks: 1
    });

    assert.equal(report.tasks_tab.rows[0].detail.detail_status, 'loaded');
    assert.equal(report.tasks_tab.rows[1].detail.detail_status, 'skipped');
    assert.equal(report.tasks_tab.rows[1].detail.stats, null);
    assert.equal(report.tasks_tab.rows[1].detail.latest_cycle_events, null);
    assert.equal(report.tasks_tab.rows[1].detail.audit, null);
    assert.deepEqual(report.tasks_tab.rows[1].detail.artifact_links, []);
    assert.ok(report.tasks_tab.rows[1].detail.unavailable.some((entry) => {
        return entry.scope === 'task:T-101:detail'
            && entry.reason.includes('detail collection is limited');
    }));
});
