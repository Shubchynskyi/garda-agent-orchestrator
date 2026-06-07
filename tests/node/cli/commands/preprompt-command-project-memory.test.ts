import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { COMMAND_SUMMARY } from '../../../../src/cli/commands/cli-helpers';
import {
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    PROJECT_MEMORY_MAP_WRITE_CONTRACT,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES
} from '../../../../src/core/project-memory';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../../src/core/project-memory-rollout';
import { computeOptionalSkillTaskTextSha256 } from '../../../../src/runtime/optional-skill-selection';
import { runCliWithCapturedOutput } from './gate-test-helpers';
import {
    createTempRepo,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue,
    writePreflight
} from './gate-test-helpers';

function seedNodeBackendOptionalSkillFixture(
    bundleRoot: string,
    options: {
        policyMode?: 'advisory' | 'required' | 'strict' | 'off' | null;
        includePersistedHeadlines?: boolean;
    } = {}
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
        'utf8'
    );
    if (options.policyMode !== null) {
        fs.writeFileSync(
            path.join(configDir, 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: options.policyMode || 'advisory' }, null, 2),
            'utf8'
        );
    }
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend specialist for request validation and API work.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n\nUse for Node backend API work.\n', 'utf8');
    if (options.includePersistedHeadlines === true) {
        fs.writeFileSync(
            path.join(configDir, 'skills-headlines.json'),
            JSON.stringify({
                version: 2,
                source_state_sha256: 'fixture-source-state',
                installed_pack_ids: ['node-backend'],
                baseline_skill_ids: [],
                installed_optional_skill_ids: ['node-backend'],
                custom_skill_ids: [],
                skills: [
                    {
                        id: 'node-backend',
                        directory: 'node-backend',
                        name: 'Node Backend',
                        summary: 'Node backend specialist for request validation and API work.',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        implemented: true,
                        review_binding: 'general_purpose',
                        aliases: ['node', 'node-backend'],
                        task_signals: ['api endpoint', 'node-backend', 'request validation'],
                        changed_path_signals: ['orders.ts', 'src/api/'],
                        tags: ['api', 'backend', 'node']
                    }
                ],
                optional_packs: []
            }, null, 2),
            'utf8'
        );
    }
}

function seedProjectMemoryFixture(repoRoot: string): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const memoryRoot = path.join(bundleRoot, 'live', 'docs', 'project-memory');
    const rulesRoot = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.mkdirSync(rulesRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(
            path.join(memoryRoot, fileName),
            [
                `# ${fileName}`,
                '',
                `Durable fixture content for ${fileName}.`
            ].join('\n'),
            'utf8'
        );
    }
    fs.writeFileSync(
        path.join(rulesRoot, '15-project-memory.md'),
        '# Project Memory Summary\n\nGenerated fixture summary.\n',
        'utf8'
    );
}

function seedProjectMemoryAgentInitState(
    repoRoot: string,
    overrides: Record<string, unknown> = {}
): void {
    const statePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
        statePath,
        JSON.stringify({
            Version: 1,
            UpdatedAt: '2026-01-01T00:00:00.000Z',
            OrchestratorVersion: null,
            AssistantLanguage: 'English',
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
            ProjectMemoryWarnings: [],
            ...overrides
        }, null, 2),
        'utf8'
    );
}

test('preprompt task --json returns read-only startup context for a queued task', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        assert.equal(payload.rule_search_required, false);
        const projectMemory = payload.project_memory as Record<string, unknown>;
        assert.ok(Array.isArray(projectMemory.read_first));
        assert.ok((projectMemory.read_first as string[]).some((entry) => entry.endsWith('/README.md')));
        assert.ok((projectMemory.warnings as string[]).some((entry) => entry.includes('agent-init')));
        assert.equal(projectMemory.init_refresh_prompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
        assert.equal((payload.task as Record<string, unknown>).id, taskId);
        assert.equal((payload.commands as Record<string, unknown>).startup_pending, true);
        assert.equal((payload.commands as Record<string, unknown>).post_implementation_sequence_available, false);
        assert.equal(Object.hasOwn(payload.diagnostics as Record<string, unknown>, 'optional_skills'), false);

        const startupCommands = (payload.commands as Record<string, unknown>).startup_commands as string[];
        assert.equal(startupCommands.length, 6);
        assert.ok(startupCommands[0].includes(`--task-id "${taskId}"`));
        assert.ok(startupCommands[0].includes('--provider "Codex"'));
        assert.ok(startupCommands.some((line) => line.includes('gate classify-change')));
        assert.ok(startupCommands.some((line) => line.includes('load-rule-pack') && line.includes('POST_PREFLIGHT')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json exposes project-memory read-first and focused suggestions', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-402';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        seedProjectMemoryAgentInitState(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'test | Update app flow',
                'workflow | Surface task-entry project memory guidance'
            ),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const projectMemory = payload.project_memory as Record<string, unknown>;
        assert.equal(projectMemory.status, 'ready');
        assert.deepEqual(projectMemory.read_strategy, 'index_first');
        assert.ok((projectMemory.summary_rule as string).endsWith('/15-project-memory.md'));
        assert.deepEqual(projectMemory.read_first, [
            'garda-agent-orchestrator/live/docs/project-memory/README.md',
            'garda-agent-orchestrator/live/docs/project-memory/compact.md'
        ]);
        const suggestedFiles = projectMemory.suggested_files as string[];
        assert.ok(suggestedFiles.includes('garda-agent-orchestrator/live/docs/project-memory/commands.md'));
        assert.ok(suggestedFiles.includes('garda-agent-orchestrator/live/docs/project-memory/module-map.md'));
        assert.ok(suggestedFiles.length < PROJECT_MEMORY_REQUIRED_FILE_NAMES.length);
        assert.deepEqual(projectMemory.warnings, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recommends canonical project-memory prompt while agent-init state is pending', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-442';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        seedProjectMemoryAgentInitState(repoRoot, {
            ProjectMemoryInitialized: true,
            ProjectMemoryValidated: false
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const projectMemory = payload.project_memory as Record<string, unknown>;
        const initializationState = projectMemory.initialization_state as Record<string, unknown>;
        assert.equal(projectMemory.status, 'partial');
        assert.equal(projectMemory.init_refresh_prompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
        assert.equal(initializationState.initialized, true);
        assert.equal(initializationState.validated, false);
        assert.equal(initializationState.pending, true);
        assert.ok((projectMemory.warnings as string[]).some((entry) => entry.includes(PROJECT_MEMORY_INIT_REFRESH_PROMPT)));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps init-refresh prompt state-gated when memory files are missing', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-443';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        seedProjectMemoryAgentInitState(repoRoot);
        fs.rmSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'README.md'),
            { force: true }
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const projectMemory = payload.project_memory as Record<string, unknown>;
        const initializationState = projectMemory.initialization_state as Record<string, unknown>;
        assert.equal(projectMemory.status, 'partial');
        assert.equal(projectMemory.init_refresh_prompt, null);
        assert.equal(initializationState.initialized, true);
        assert.equal(initializationState.validated, true);
        assert.equal(initializationState.pending, false);
        assert.ok((projectMemory.missing_files as string[]).some((entry) => entry.endsWith('/README.md')));
        assert.ok((projectMemory.warnings as string[]).some((entry) => entry.includes(PROJECT_MEMORY_INIT_REFRESH_PROMPT)));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json treats invalid project-memory readiness state as pending', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-443';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json'),
            '{"ProjectMemoryInitialized":',
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const projectMemory = payload.project_memory as Record<string, unknown>;
        const initializationState = projectMemory.initialization_state as Record<string, unknown>;
        assert.equal(projectMemory.status, 'partial');
        assert.equal(projectMemory.init_refresh_prompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
        assert.equal(initializationState.initialized, false);
        assert.equal(initializationState.validated, false);
        assert.equal(initializationState.pending, true);
        assert.match(String(initializationState.error), /Invalid JSON/);
        assert.ok((projectMemory.warnings as string[]).some((entry) => entry.includes('agent-init state is invalid')));
        assert.ok((projectMemory.warnings as string[]).some((entry) => entry.includes(PROJECT_MEMORY_INIT_REFRESH_PROMPT)));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task project-memory suggestions vary by task area', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-403';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        seedProjectMemoryAgentInitState(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'test | Update app flow',
                'architecture | Redesign component boundary decision'
            ),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const projectMemory = payload.project_memory as Record<string, unknown>;
        const suggestedFiles = projectMemory.suggested_files as string[];
        assert.ok(suggestedFiles.includes('garda-agent-orchestrator/live/docs/project-memory/architecture.md'));
        assert.ok(suggestedFiles.includes('garda-agent-orchestrator/live/docs/project-memory/decisions.md'));
        assert.ok(!suggestedFiles.includes('garda-agent-orchestrator/live/docs/project-memory/conventions.md'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output includes ProjectMemoryReadFirst and map guidance', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-404';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        seedProjectMemoryFixture(repoRoot);
        seedProjectMemoryAgentInitState(repoRoot);

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const output = result.logs.join('\n');
        assert.ok(output.includes('ProjectMemoryReadFirst:'));
        assert.ok(output.includes('ProjectMemoryTaskStartGuidance:'));
        assert.ok(output.includes(PROJECT_MEMORY_MAP_READ_GUIDANCE));
        assert.ok(output.includes(PROJECT_MEMORY_MAP_WRITE_CONTRACT));
        assert.ok(output.includes('garda-agent-orchestrator/live/docs/project-memory/README.md'));
        assert.ok(!output.includes('ProjectMemoryInitRefreshPrompt:'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

