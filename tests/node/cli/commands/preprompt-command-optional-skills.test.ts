import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

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

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeSelectedNodeBackendOptionalSkillArtifact(
    repoRoot: string,
    taskId: string,
    options: {
        policyMode: 'advisory' | 'required' | 'strict';
        preflightPath: string;
    }
): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
        artifactPath,
        JSON.stringify({
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            policy_mode: options.policyMode,
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
            preflight_path: options.preflightPath.replace(/\\/g, '/'),
            preflight_sha256: sha256File(options.preflightPath),
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: null,
            visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
        }, null, 2),
        'utf8'
    );
}

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
        assert.match(String(optionalSkills.skill_catalog_path || ''), /garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /Selected optional skill\(s\): node-backend/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /activate the selected skill/i);
        assert.match(String(optionalSkills.visible_summary_line || ''), /Optional skills: node-backend/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps current advisory optional-skill activation guidance non-blocking', async () => {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'advisory',
            preflightPath
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
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, true);
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Selected advisory optional skill\(s\): node-backend/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /If you use the selected skill, run the activation command\(s\)/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /otherwise continue with the normal navigator command/
        );
        assert.doesNotMatch(
            String(optionalSkills.task_start_instruction || ''),
            /Run the activation command\(s\) before implementation so the timeline records the required chosen role\/skill/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps current required optional-skill activation guidance mandatory', async () => {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'required',
            preflightPath
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'required');
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, true);
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Selected optional skill\(s\): node-backend/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Run the activation command\(s\) before implementation so the timeline records the required chosen role\/skill/
        );
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
        assert.match(output, /OptionalSkillTaskStartInstruction:/);
        assert.match(output, /Selected optional skill\(s\): node-backend/);
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
        assert.match(String(optionalSkills.skill_catalog_path || ''), /garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /No specialized optional skill selected/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /Compact catalog: garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
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
