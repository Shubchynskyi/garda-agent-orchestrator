import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { COMMAND_SUMMARY } from '../../../../src/cli/commands/cli-helpers';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
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

test('COMMAND_SUMMARY includes preprompt', () => {
    assert.equal(
        COMMAND_SUMMARY.find((entry) => entry[0] === 'preprompt')?.[1],
        'Read-only task bootstrap context and exact next commands'
    );
});

test('preprompt task --help renders command help', async () => {
    const result = await runCliWithCapturedOutput(['preprompt', 'task', '--help']);
    assert.equal(result.exitCode, 0);
    const output = result.logs.join('\n');
    assert.ok(output.includes('Command: preprompt task'));
    assert.ok(output.includes('--task-id "<task-id>"'));
    assert.ok(output.includes('--json'));
});

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

test('preprompt task text output includes ProjectMemoryReadFirst', async () => {
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
        assert.ok(output.includes('garda-agent-orchestrator/live/docs/project-memory/README.md'));
        assert.ok(!output.includes('ProjectMemoryInitRefreshPrompt:'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json derives post-implementation commands from current preflight', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts',
                'tests/node/cli/commands/preprompt-command.test.ts'
            ]
        });
        assert.ok(fs.existsSync(preflightPath));

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        assert.deepEqual(diagnostics.required_review_types, ['code', 'test']);
        assert.equal(commands.post_implementation_sequence_available, true);
        const postImplementationCommands = commands.post_implementation_commands as string[];
        assert.ok(postImplementationCommands[0].includes('gate compile-gate'));
        assert.ok(postImplementationCommands.some((line) => line.includes('build-review-context') && line.includes('--review-type "code"')));
        assert.ok(postImplementationCommands.some((line) => line.includes('build-review-context') && line.includes('--review-type "test"')));
        assert.ok(postImplementationCommands.some((line) => line.includes('required-reviews-check')));
        assert.ok(postImplementationCommands.some((line) => line.includes('completion-gate')));

        const latestPreflight = diagnostics.latest_preflight as Record<string, unknown>;
        assert.equal(latestPreflight.mode, 'FULL_PATH');
        assert.deepEqual(latestPreflight.changed_files, [
            'src/cli/commands/preprompt-command.ts',
            'tests/node/cli/commands/preprompt-command.test.ts'
        ]);
        assert.equal(latestPreflight.changed_files_truncated, false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output includes post-implementation commands from current preflight', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts',
                'tests/node/cli/commands/preprompt-command.test.ts'
            ]
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const output = result.logs.join('\n');
        assert.match(output, /PostImplementationCommands:/);
        assert.match(output, /gate compile-gate/);
        assert.match(output, /build-review-context --review-type "code"/);
        assert.match(output, /build-review-context --review-type "test"/);
        assert.match(output, /required-reviews-check/);
        assert.match(output, /completion-gate/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reuses rule-pack artifacts for exact startup load-rule-pack commands', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: [
                'src/cli/commands/preprompt-command.ts'
            ]
        });
        const rulePackPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-rule-pack.json`);
        fs.writeFileSync(rulePackPath, JSON.stringify({
            latest_stage: 'POST_PREFLIGHT',
            stages: {
                task_entry: {
                    loaded_rule_files: [
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md')
                    ]
                },
                post_preflight: {
                    loaded_rule_files: [
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '35-strict-coding-rules.md'),
                        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md')
                    ]
                }
            }
        }, null, 2), 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const startupCommands = ((payload.commands as Record<string, unknown>).startup_commands as string[]);
        const taskEntryCommand = startupCommands.find((line) => line.includes('load-rule-pack') && line.includes('TASK_ENTRY'));
        const postPreflightCommand = startupCommands.find((line) => line.includes('load-rule-pack') && line.includes('POST_PREFLIGHT'));
        assert.ok(taskEntryCommand);
        assert.ok(postPreflightCommand);
        assert.match(String(taskEntryCommand), /live\/docs\/agent-rules\/00-core\.md/);
        assert.match(String(taskEntryCommand), /live\/docs\/agent-rules\/40-commands\.md/);
        assert.match(String(postPreflightCommand), /live\/docs\/agent-rules\/35-strict-coding-rules\.md/);
        assert.ok(!String(postPreflightCommand).includes('<task-specific-downstream-rule-file>'));
        assert.ok(!String(postPreflightCommand).includes('<additional-task-specific-rule-file>'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json does not invent --use-staged for an unstaged-only dirty workspace', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const startupCommands = commands.startup_commands as string[];
        assert.ok(startupCommands.some((line) => line.includes('--changed-file "src/<file>"')));
        assert.ok(!startupCommands.some((line) => line.includes('gate classify-change') && line.includes('--use-staged')));
        assert.match(
            String(commands.startup_scope_blocker || ''),
            /explicit --changed-file entries|stage only the intended task diff/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output reports dirty-workspace startup blocker', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const output = result.logs.join('\n');
        assert.match(output, /GARDA_PREPROMPT_TASK/);
        assert.match(output, /StartupScopeBlocker:/);
        assert.match(output, /explicit --changed-file entries|stage only the intended task diff/i);
        assert.ok(!output.includes('gate classify-change --task-id "T-137" --use-staged'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json emits --use-staged when staged task scope exists', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Codex');
        childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['config', 'user.name', 'Preprompt Tests'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
        childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        childProcess.execFileSync('git', ['add', 'src/app.ts'], { cwd: repoRoot, stdio: 'ignore' });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const startupCommands = commands.startup_commands as string[];
        assert.ok(startupCommands.some((line) => line.includes('gate classify-change') && line.includes('--use-staged')));
        assert.equal(commands.startup_scope_blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json bounds artifact and changed-file lists', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-137';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const changedFiles = Array.from({ length: 20 }, (_, index) => `src/generated/file-${index + 1}.ts`);
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: changedFiles
        });
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        for (let index = 0; index < 15; index += 1) {
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-artifact-${index + 1}.json`), `artifact-${index + 1}\n`, 'utf8');
        }

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const artifacts = payload.artifacts as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const latestPreflight = diagnostics.latest_preflight as Record<string, unknown>;
        assert.equal((artifacts.review_artifacts as string[]).length, 12);
        assert.equal(artifacts.review_artifacts_total_count, 16);
        assert.equal(artifacts.review_artifacts_truncated, true);
        assert.equal(latestPreflight.changed_files_total_count, 20);
        assert.equal((latestPreflight.changed_files as string[]).length, 12);
        assert.equal(latestPreflight.changed_files_truncated, true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json shows optional skill selection preview from headlines-based selection', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'advisory');
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.match(String(optionalSkills.visible_summary_line || ''), /Optional skills: node-backend/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports optional skills as disabled when policy mode is off', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'off',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'off');
        assert.equal(optionalSkills.decision, null);
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.as_is_reason, 'policy_off');
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.visible_summary_line || ''), /Optional skills: as_is \(reason: policy_off\)/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json blocks required optional-skill policy until the current-cycle artifact is materialized, while still exposing the preview decision', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'required');
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.match(String(optionalSkills.blocker || ''), /requires a materialized current-cycle selection artifact/i);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(
            String(optionalSkills.selected_installed_skill_activation_blocker || ''),
            /requires a current materialized selection artifact/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output reports required optional-skill blocker before exiting non-zero', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const output = result.logs.join('\n');
        assert.match(output, /GARDA_PREPROMPT_TASK/);
        assert.match(output, /OptionalSkillTaskStartBlocker:/);
        assert.match(output, /requires a materialized current-cycle selection artifact/i);
        assert.deepEqual(result.errors, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps advisory optional-skill preview available when persisted headlines are missing', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: false
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'advisory');
        assert.equal(optionalSkills.blocker, null);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports structured optional-skill diagnostics when the policy config is malformed', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            '{',
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.current_policy_mode, null);
        assert.match(String(optionalSkills.blocker || ''), /preview is unavailable/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json fails fast when garda.config.json maps a missing optional-skill-selection policy file', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        fs.rmSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            { force: true }
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.current_policy_mode, null);
        assert.match(String(optionalSkills.blocker || ''), /policy config is missing/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json derives optional-skill preview from task-mode planned scope before preflight exists', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Harden entry flow sequencing for the current task'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: false
        });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Harden entry flow sequencing for the current task',
            plannedChangedFiles: ['src/api/orders.ts']
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'advisory');
        assert.equal(optionalSkills.blocker, null);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.ok((commands.startup_commands as string[]).some((entry) => entry.includes('--changed-file "src/api/orders.ts"')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes advisory optional-skill preview instead of reusing a stale materialized artifact', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Tighten task-audit-summary closeout wiring'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/gates/task-audit-summary.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
        assert.equal(optionalSkills.blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes optional-skill preview when the materialized artifact points to a skill missing from the current live inventory', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-preflight.json`);
        const preflightSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(preflightPath)})).digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const persistedHeadlinesSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');const text=fs.readFileSync(${JSON.stringify(headlinesPath)},'utf8').trim()+'\\n';process.stdout.write(crypto.createHash('sha256').update(text,'utf8').digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: preflightSha256,
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: persistedHeadlinesSha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'node-backend'), { recursive: true, force: true });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
        assert.equal(optionalSkills.blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes optional-skill preview when the current TASK.md title no longer matches the materialized task summary hash', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['docs/landing.md']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        const preflightSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(preflightPath)})).digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const persistedHeadlinesSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');const text=fs.readFileSync(${JSON.stringify(headlinesPath)},'utf8').trim()+'\\n';process.stdout.write(crypto.createHash('sha256').update(text,'utf8').digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: []
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: preflightSha256,
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: persistedHeadlinesSha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports a blocker when an existing optional-skill artifact no longer matches the current preflight', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'required',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.match(String(optionalSkills.blocker || ''), /current preflight artifact/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports a blocker when an existing optional-skill artifact no longer matches the current policy mode', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'strict',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: []
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.match(String(optionalSkills.blocker || ''), /current policy mode 'strict'/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
