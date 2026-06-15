import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import {
    buildBackupsTab,
    buildReportDataContract,
    buildReportSnapshotFingerprint,
    buildReportTaskDetail,
    buildWorkflowConfigTab,
    readCanonicalActiveQueueRows
} from '../../../src/reports/report-data-contract';
import { writeRollbackRecords } from '../../../src/lifecycle/common';

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

function writePathsConfig(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        ordinary_doc_paths: ['CHANGELOG.md']
    }, null, 2));
    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
}

function writeProfilesConfig(repoRoot: string): void {
    const profilesPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json');
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    fs.writeFileSync(profilesPath, JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {},
            fast: {},
            strict: {},
            'docs-only': {}
        },
        user_profiles: {
            'custom-review': {}
        }
    }, null, 2));
}

function writeReviewCapabilities(repoRoot: string): void {
    const capabilitiesPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json');
    fs.mkdirSync(path.dirname(capabilitiesPath), { recursive: true });
    fs.writeFileSync(capabilitiesPath, JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: false,
        infra: false,
        dependency: true
    }, null, 2));
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function writePreflight(repoRoot: string, taskId = 'T-100'): string {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    fs.writeFileSync(preflightPath, JSON.stringify({
        task_id: taskId,
        mode: 'FULL_PATH',
        changed_files: ['src/reports/report-data-contract.ts'],
        metrics: {
            changed_lines_total: 12,
            changed_files_sha256: sha256Text('src/reports/report-data-contract.ts'),
            scope_sha256: sha256Text('scope'),
            scope_content_sha256: sha256Text('content')
        },
        required_reviews: { code: true }
    }, null, 2));
    return preflightPath;
}

function writeCompileEvent(repoRoot: string, taskId = 'T-100', timestamp = '2026-05-16T00:01:00.000Z'): string {
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(path.join(eventsRoot, `${taskId}.jsonl`), `${JSON.stringify({
        schema_version: 2,
        task_id: taskId,
        timestamp_utc: timestamp,
        event_type: 'COMPILE_GATE_PASSED',
        outcome: 'PASS',
        actor: 'orchestrator',
        message: 'compile passed',
        details: {}
    })}\n`);
    return timestamp;
}

function writeFullSuiteArtifact(repoRoot: string, options: {
    taskId?: string;
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED';
    durationMs?: number | null;
    timedOut?: boolean;
    exitCode?: number | null;
    compileTimestamp: string;
    preflightPath: string;
}): void {
    const taskId = options.taskId || 'T-100';
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const outputPath = path.join(reviewsRoot, `${taskId}-full-suite-output.log`);
    fs.writeFileSync(outputPath, '# tests 10\n# pass 10\n', 'utf8');
    fs.writeFileSync(artifactPath, JSON.stringify({
        status: options.status,
        enabled: true,
        command: 'npm test',
        exit_code: options.exitCode ?? (options.status === 'PASSED' ? 0 : 1),
        timed_out: options.timedOut === true,
        output_artifact_path: outputPath,
        compact_summary: ['# tests 10', '# pass 10'],
        failure_chunks: options.status === 'FAILED' ? [['not ok timed out']] : [],
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        duration_ms: options.durationMs,
        cycle_binding: {
            task_id: taskId,
            preflight_path: options.preflightPath,
            preflight_sha256: createHash('sha256').update(fs.readFileSync(options.preflightPath)).digest('hex'),
            compile_gate_timestamp: options.compileTimestamp,
            scope_binding: {
                changed_files_sha256: sha256Text('src/reports/report-data-contract.ts'),
                scope_sha256: sha256Text('scope'),
                scope_content_sha256: sha256Text('content')
            }
        }
    }, null, 2));
}

function writeInitAndProjectMemory(repoRoot: string): void {
    writePathsConfig(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent instructions\n', 'utf8');
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
    writeProfilesConfig(repoRoot);
    writeReviewCapabilities(repoRoot);

    const tab = buildWorkflowConfigTab(repoRoot);

    assert.equal(tab.status, 'present');
    assert.equal(tab.config_exists, true);
    assert.ok(tab.settings.length > 0);
    const compileGate = tab.settings.find((setting) => setting.key === 'compile_gate.command');
    assert.ok(compileGate);
    assert.equal(compileGate.label, 'Compile-gate command');
    assert.equal(compileGate.value_type, 'string');
    assert.match(compileGate.command, /garda workflow set --compile-gate-command <value>/);
    assert.match(compileGate.description, /40-commands\.md/);
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
    const scopeProfiles = tab.settings.find((setting) => setting.key === 'scope_budget_guard.profiles');
    assert.ok(scopeProfiles);
    assert.equal(scopeProfiles.value_type, 'enum_list');
    assert.ok(scopeProfiles.options.some((option) => option.value === 'strict'));
    assert.ok(scopeProfiles.options.some((option) => option.value === 'custom-review'));
    assert.match(scopeProfiles.command, /--scope-budget-profiles <comma-separated: /u);
    const excludedReviewTypes = tab.settings.find((setting) => setting.key === 'review_cycle_guard.excluded_review_types');
    assert.ok(excludedReviewTypes);
    assert.equal(excludedReviewTypes.value_type, 'enum_list');
    assert.ok(excludedReviewTypes.options.some((option) => option.value === 'test'));
    assert.ok(excludedReviewTypes.options.some((option) => option.value === 'performance' && option.description.includes('disabled')));
    assert.match(excludedReviewTypes.command, /--review-cycle-excluded-review-types <comma-separated: /u);
});

test('buildWorkflowConfigTab preserves unknown legacy enum-list values with diagnostics', () => {
    const repoRoot = makeTempRepo();
    writeWorkflowConfig(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    config.scope_budget_guard.profiles = ['strict', 'Old-Profile'];
    config.review_cycle_guard.excluded_review_types = ['test', 'Legacy-Review'];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const tab = buildWorkflowConfigTab(repoRoot);

    const scopeProfiles = tab.settings.find((setting) => setting.key === 'scope_budget_guard.profiles');
    assert.ok(scopeProfiles);
    assert.ok(scopeProfiles.options.some((option) => option.value === 'Old-Profile' && option.description.includes('legacy')));
    assert.ok(!scopeProfiles.options.some((option) => option.value === 'old-profile'));
    const excludedReviewTypes = tab.settings.find((setting) => setting.key === 'review_cycle_guard.excluded_review_types');
    assert.ok(excludedReviewTypes);
    assert.ok(excludedReviewTypes.options.some((option) => option.value === 'Legacy-Review' && option.description.includes('legacy')));
    assert.ok(!excludedReviewTypes.options.some((option) => option.value === 'legacy-review'));
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
    assert.ok(report.init_settings_tab.init_answers.some((row) => row.id === 'SourceOfTruth' && row.value === 'Codex (AGENTS.md)' && row.file_path === 'AGENTS.md'));
    assert.ok(!report.init_settings_tab.init_answers.some((row) => row.id === 'CollectedVia' || row.id === 'ActiveAgentFiles'));
    assert.ok(!report.init_settings_tab.agent_init_state.some((row) => row.id === 'UpdatedAt' || row.id.startsWith('ProjectMemory') || row.id === 'ActiveAgentFiles'));
    assert.deepEqual(report.init_settings_tab.ordinary_docs.paths, ['CHANGELOG.md']);
    assert.ok(report.init_settings_tab.commands.some((command) => command.id === 'reinit'));
    assert.ok(report.init_settings_tab.commands.some((command) => command.id === 'agent-init' && command.command.includes('AGENT_INIT_PROMPT.md')));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-mode' && row.value === 'update'));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-initialized' && row.value === true));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-validated' && row.value === true));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-read-first' && Array.isArray(row.value) && row.value.includes('live/docs/project-memory/README.md')));
    assert.ok(report.project_memory_tab.files.some((file) => file.path.endsWith('project-memory/compact.md') && file.exists && file.size_bytes !== null));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Task execution'));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Review execution modes'));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Backups'));
    assert.equal(report.backups_tab.auto_backup.enabled, false);
    assert.equal(report.backups_tab.auto_backup.keep_latest, 10);
    assert.deepEqual(report.backups_tab.rows, []);
    assert.equal(report.backups_tab.snapshots_root_exists, false);
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

test('buildReportTaskDetail exposes current full-suite pass duration and forecast', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot);
    const compileTimestamp = writeCompileEvent(repoRoot);
    writeFullSuiteArtifact(repoRoot, {
        status: 'PASSED',
        durationMs: 123456,
        compileTimestamp,
        preflightPath
    });

    const detail = buildReportTaskDetail({ taskId: 'T-100', repoRoot });

    assert.equal(detail.full_suite_validation.state, 'passed');
    assert.equal(detail.full_suite_validation.freshness, 'current');
    assert.equal(detail.full_suite_validation.duration_ms, 123456);
    assert.equal(detail.full_suite_validation.duration_human, '2m 3.5s');
    assert.equal(detail.full_suite_validation.command, 'npm test');
    assert.equal(detail.full_suite_validation.timeout_forecast.recommendation_source, 'config_timeout');
    assert.match(detail.full_suite_validation.artifact_path, /T-100-full-suite-validation\.json$/);
});

test('buildReportTaskDetail marks required full-suite evidence as not run when artifact is missing', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writePreflight(repoRoot);
    writeCompileEvent(repoRoot);

    const detail = buildReportTaskDetail({ taskId: 'T-100', repoRoot });

    assert.equal(detail.full_suite_validation.state, 'not_run');
    assert.equal(detail.full_suite_validation.freshness, 'missing');
    assert.equal(detail.full_suite_validation.required, true);
    assert.equal(detail.full_suite_validation.duration_ms, null);
    assert.match(detail.full_suite_validation.mismatch_reason || '', /artifact is missing/);
});

test('buildBackupsTab lists inventory rows without inventing backup state', () => {
    const repoRoot = makeTempRepo();
    writeWorkflowConfig(repoRoot);
    const snapshotPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'update-rollbacks',
        'update-20260501-010000-000'
    );
    const versionPath = path.join(snapshotPath, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, 'backup-version\n', 'utf8');
    writeRollbackRecords(snapshotPath, [{
        relativePath: 'garda-agent-orchestrator/VERSION',
        existed: true,
        pathType: 'file'
    }]);

    const tab = buildBackupsTab(repoRoot);

    assert.equal(tab.snapshots_root_exists, true);
    assert.equal(tab.rows.length, 1);
    assert.equal(tab.rows[0].id, 'update-20260501-010000-000');
    assert.equal(tab.rows[0].reason, 'update');
    assert.equal(tab.rows[0].health, 'AVAILABLE');
    assert.equal(tab.rows[0].restorable, true);
    assert.ok(tab.rows[0].size_bytes > 0);
    assert.match(tab.rows[0].size_human, /B|KB|MB/);
    assert.equal(tab.auto_backup.enabled, false);
    assert.equal(tab.unavailable.length, 0);
});

test('buildReportSnapshotFingerprint changes when backup inventory root changes', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const before = buildReportSnapshotFingerprint(repoRoot);
    const snapshotsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'update-rollbacks');
    const snapshotPath = path.join(snapshotsRoot, 'update-20260501-010000-000');
    const versionPath = path.join(snapshotPath, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, 'backup-version\n', 'utf8');
    writeRollbackRecords(snapshotPath, [{
        relativePath: 'garda-agent-orchestrator/VERSION',
        existed: true,
        pathType: 'file'
    }]);
    const after = buildReportSnapshotFingerprint(repoRoot);
    assert.notEqual(before, after);
});

test('buildReportTaskDetail surfaces timed-out full-suite failures without inventing duration', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot);
    const compileTimestamp = writeCompileEvent(repoRoot);
    writeFullSuiteArtifact(repoRoot, {
        status: 'FAILED',
        durationMs: null,
        timedOut: true,
        exitCode: null,
        compileTimestamp,
        preflightPath
    });

    const detail = buildReportTaskDetail({ taskId: 'T-100', repoRoot });

    assert.equal(detail.full_suite_validation.state, 'timed_out');
    assert.equal(detail.full_suite_validation.status, 'FAILED');
    assert.equal(detail.full_suite_validation.timed_out, true);
    assert.equal(detail.full_suite_validation.duration_ms, null);
    assert.equal(detail.full_suite_validation.duration_human, null);
    assert.deepEqual(detail.full_suite_validation.compact_summary, ['# tests 10', '# pass 10']);
});
