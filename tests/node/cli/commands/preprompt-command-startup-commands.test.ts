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

