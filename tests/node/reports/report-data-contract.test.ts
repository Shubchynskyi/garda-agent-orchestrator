import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { buildEventIntegrityHash } from '../../../src/gate-runtime/task-events';
import {
    buildBackupsTab,
    buildQualityGateTab,
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

function writeTaskMdWithActiveRows(repoRoot: string, rows: readonly string[]): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        ''
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

function writePartialTaskTimeline(repoRoot: string, taskId: string): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const taskModeEvent: Record<string, unknown> = {
        timestamp_utc: '2026-05-16T00:00:00.000Z',
        task_id: taskId,
        event_type: 'TASK_MODE_ENTERED',
        outcome: 'PASS',
        actor: 'gate',
        message: 'Task mode entered.',
        details: {},
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null,
            event_sha256: ''
        }
    };
    (taskModeEvent.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(taskModeEvent);
    fs.writeFileSync(timelinePath, `${JSON.stringify(taskModeEvent)}\n`, 'utf8');
}

function writeMalformedTaskTimeline(repoRoot: string, taskId: string, malformedLineCount: number): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(
        timelinePath,
        Array.from({ length: malformedLineCount }, (_, index) => `{malformed-${index}}\n`).join(''),
        'utf8'
    );
}

function writeStaleTaskEventLock(repoRoot: string, taskId: string): void {
    const lockPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `.${taskId}.lock`);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        lock_id: 'stale-lock',
        pid: 99999999,
        hostname: os.hostname(),
        created_at_utc: '2026-03-30T10:00:00.000Z',
        heartbeat_at_utc: '2026-03-30T10:00:00.000Z',
        command: 'node bin/garda.js next-step'
    }, null, 2), 'utf8');
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

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writePreflight(repoRoot: string, taskId = 'T-100', options: {
    changedFiles?: string[];
    scopeSeed?: string;
    contentSeed?: string;
} = {}): string {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const changedFiles = options.changedFiles || ['src/reports/report-data-contract.ts'];
    fs.writeFileSync(preflightPath, JSON.stringify({
        task_id: taskId,
        mode: 'FULL_PATH',
        detection_source: 'explicit_changed_files',
        changed_files: changedFiles,
        metrics: {
            changed_lines_total: 12,
            changed_files_sha256: sha256Text(changedFiles.sort().join('\n')),
            scope_sha256: sha256Text(options.scopeSeed || 'scope'),
            scope_content_sha256: sha256Text(options.contentSeed || 'content')
        },
        required_reviews: { code: true }
    }, null, 2));
    return preflightPath;
}

function writeQualityChecklistArtifact(repoRoot: string, options: {
    taskId: string;
    status: string;
    timestampUtc: string;
    preflightPath: string;
    actionsTaken?: string[];
    actionsRequired?: string[];
    checklistId?: string;
}): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const actionsTaken = options.actionsTaken ?? [];
    const actionsRequired = options.actionsRequired ?? [];
    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as {
        changed_files?: string[];
        metrics?: Record<string, string>;
    };
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map(String).sort()
        : ['src/reports/report-data-contract.ts'];
    const metrics = preflight.metrics || {};
    fs.writeFileSync(path.join(reviewsRoot, `${options.taskId}-quality-checklist.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: options.timestampUtc,
        event_source: 'quality-checklist',
        task_id: options.taskId,
        checklist_id: options.checklistId ?? 'optional_quality_checks',
        status: options.status,
        outcome: options.status === 'WARN' ? 'WARN' : 'FAIL',
        workflow_config_path: workflowConfigPath,
        workflow_config_sha256: sha256File(workflowConfigPath),
        preflight_path: options.preflightPath,
        preflight_sha256: sha256File(options.preflightPath),
        changed_file_evidence: {
            changed_files: changedFiles,
            changed_files_count: changedFiles.length,
            changed_files_sha256: metrics.changed_files_sha256 || sha256Text(changedFiles.join('\n')),
            scope_sha256: metrics.scope_sha256 || sha256Text('scope'),
            scope_content_sha256: metrics.scope_content_sha256 || sha256Text('content')
        },
        rules: [{
            id: 'code_simplification',
            title: 'Code simplification',
            prompt: 'Check simplification.',
            enabled: true
        }],
        answers: [{
            rule_id: 'code_simplification',
            status: options.status,
            answer: options.status === 'WARN' ? 'Watch the helper size.' : 'Extract the history parser before review.',
            evidence_files: ['src/reports/report-data/quality-gate-evidence.ts'],
            actions_taken: actionsTaken,
            actions_required: actionsRequired
        }],
        actions_taken: actionsTaken,
        actions_required: actionsRequired,
        violations: []
    }, null, 2));
}

function writeQualityChecklistArtifactWithPreflightReference(repoRoot: string, options: {
    taskId: string;
    status: string;
    timestampUtc: string;
    preflightPath: string;
}): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const changedFiles = ['src/reports/report-data-contract.ts'];
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${options.taskId}-quality-checklist.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: options.timestampUtc,
        event_source: 'quality-checklist',
        task_id: options.taskId,
        checklist_id: 'optional_quality_checks',
        status: options.status,
        outcome: options.status === 'WARN' ? 'WARN' : 'FAIL',
        workflow_config_path: workflowConfigPath,
        workflow_config_sha256: sha256File(workflowConfigPath),
        preflight_path: options.preflightPath,
        preflight_sha256: sha256File(options.preflightPath),
        changed_file_evidence: {
            changed_files: changedFiles,
            changed_files_count: changedFiles.length,
            changed_files_sha256: sha256Text(changedFiles.join('\n')),
            scope_sha256: sha256Text('scope'),
            scope_content_sha256: sha256Text('content')
        },
        rules: [{
            id: 'code_simplification',
            title: 'Code simplification',
            prompt: 'Check simplification.',
            enabled: true
        }],
        answers: [{
            rule_id: 'code_simplification',
            status: options.status,
            answer: 'Keep quality-check evidence bounded to trusted repository files.',
            evidence_files: ['src/reports/report-data/quality-gate-evidence.ts'],
            actions_taken: [],
            actions_required: []
        }],
        actions_taken: [],
        actions_required: [],
        violations: []
    }, null, 2));
}

function writeQualityChecklistTimelineEvent(repoRoot: string, options: {
    taskId: string;
    status: 'WARN' | 'ACTION_REQUIRED';
    timestampUtc: string;
    actionsRequired?: string[];
}): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${options.taskId}.jsonl`);
    const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${options.taskId}-quality-checklist.json`);
    const actionsRequired = options.actionsRequired ?? [];
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.appendFileSync(timelinePath, `${JSON.stringify({
        schema_version: 2,
        task_id: options.taskId,
        timestamp_utc: options.timestampUtc,
        event_type: 'QUALITY_CHECKLIST_RECORDED',
        outcome: options.status === 'WARN' ? 'WARN' : 'FAIL',
        actor: 'gate',
        message: `Quality checklist recorded: ${options.status}.`,
        details: {
            status: options.status,
            checklist_id: 'optional_quality_checks',
            artifact_path: artifactPath,
            artifact_hash: fs.existsSync(artifactPath) ? sha256File(artifactPath) : null,
            action_required_count: options.status === 'ACTION_REQUIRED'
                ? Math.max(actionsRequired.length, 1)
                : 0,
            actions_required: actionsRequired,
            changed_files_count: 1,
            changed_files_preview: ['src/reports/report-data-contract.ts']
        }
    })}\n`, 'utf8');
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
    const promptPath = path.join(repoRoot, 'template', 'docs', 'prompts', 'project-memory-optimization.md');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, '# Project memory optimization prompt\n');
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
    assert.equal(tab.optional_quality_checks.enabled, true);
    assert.ok(tab.optional_quality_checks.rules.some((rule) => rule.id === 'code_simplification'));
    const compileGate = tab.settings.find((setting) => setting.key === 'compile_gate.command');
    assert.ok(compileGate);
    assert.equal(compileGate.label, 'Compile-gate command');
    assert.equal(compileGate.value_type, 'string');
    assert.equal(compileGate.placeholder, 'compile/build/type-check command');
    assert.equal(compileGate.editable, true);
    assert.match(compileGate.command, /garda workflow set --compile-gate-command <compile\/build\/type-check command>/);
    assert.match(compileGate.description, /Local UI edits use the same audited `garda workflow set` path/u);
    assert.match(compileGate.description, /fails closed/);
    assert.match(compileGate.description, /never falls back to 40-commands\.md/);
    const fullSuiteCommand = tab.settings.find((setting) => setting.key === 'full_suite_validation.command');
    assert.ok(fullSuiteCommand);
    assert.equal(fullSuiteCommand.editable, true);
    const fullSuite = tab.settings.find((setting) => setting.key === 'full_suite_validation.enabled');
    assert.ok(fullSuite);
    assert.equal(fullSuite.value, true);
    assert.equal(fullSuite.readonly, true);
    assert.equal(fullSuite.label, 'Mandatory full-suite validation');
    assert.equal(fullSuite.value_type, 'boolean');
    assert.ok(fullSuite.options.some((option) => option.value === 'true'));
    assert.match(fullSuite.command, /garda workflow set --full-suite-enabled <true\|false>/);
    assert.match(fullSuite.description, /full-suite/i);
    const optionalChecksEnabled = tab.settings.find((setting) => setting.key === 'optional_quality_checks.enabled');
    assert.ok(optionalChecksEnabled);
    assert.equal(optionalChecksEnabled.value, true);
    assert.equal(optionalChecksEnabled.label, 'Optional quality checks');
    assert.match(optionalChecksEnabled.command, /garda workflow set --optional-checks-enabled <true\|false>/);
    const fullSuiteTimeoutBlocker = tab.settings.find((setting) => setting.key === 'full_suite_validation.timeout_blocker');
    assert.ok(fullSuiteTimeoutBlocker);
    assert.equal(fullSuiteTimeoutBlocker.value, true);
    assert.equal(fullSuiteTimeoutBlocker.label, 'Full-suite timeout blocker');
    assert.match(fullSuiteTimeoutBlocker.command, /garda workflow set --full-suite-timeout-blocker <true\|false>/);
    const fullSuiteTimeoutRetryCount = tab.settings.find((setting) => setting.key === 'full_suite_validation.timeout_retry_count');
    assert.ok(fullSuiteTimeoutRetryCount);
    assert.equal(fullSuiteTimeoutRetryCount.value, 1);
    assert.equal(fullSuiteTimeoutRetryCount.label, 'Full-suite timeout retries');
    assert.equal(fullSuiteTimeoutRetryCount.max, 3);
    assert.match(fullSuiteTimeoutRetryCount.command, /garda workflow set --full-suite-timeout-retry-count <number>/);
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
    assert.ok(excludedReviewTypes.options.some((option) => option.value === 'performance' && option.label === 'Performance review'));
    assert.match(excludedReviewTypes.command, /--review-cycle-excluded-review-types <comma-separated: /u);
    const projectMemoryCompactLimit = tab.settings.find((setting) => setting.key === 'project_memory_maintenance.max_compact_summary_chars');
    assert.ok(projectMemoryCompactLimit);
    assert.equal(projectMemoryCompactLimit.value_type, 'integer');
    assert.equal(projectMemoryCompactLimit.flag, '--project-memory-max-compact-summary-chars');
    assert.match(projectMemoryCompactLimit.command, /garda workflow set --project-memory-max-compact-summary-chars <number>/);
    const taskReset = tab.settings.find((setting) => setting.key === 'task_reset.enabled');
    assert.ok(taskReset);
    assert.equal(taskReset.value, false);
    assert.equal(taskReset.readiness?.ready, false);
    assert.equal(taskReset.readiness?.configured_enabled, false);
    assert.equal(taskReset.readiness?.audited_enablement, false);
});

test('buildWorkflowConfigTab separates task reset config value from audited readiness', () => {
    const repoRoot = makeTempRepo();
    writeWorkflowConfig(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    config.task_reset.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const tab = buildWorkflowConfigTab(repoRoot);

    const taskReset = tab.settings.find((setting) => setting.key === 'task_reset.enabled');
    assert.ok(taskReset);
    assert.equal(taskReset.value, true);
    assert.equal(taskReset.readiness?.ready, false);
    assert.equal(taskReset.readiness?.configured_enabled, true);
    assert.equal(taskReset.readiness?.audited_enablement, false);
    assert.match(taskReset.readiness?.disabled_reason || '', /no matching audited workflow set record/u);
    assert.match(taskReset.readiness?.remediation_command || '', /workflow set --target-root "\." --task-reset-enabled true/u);
    assert.equal(taskReset.readiness?.remediation_action_id, 'task-reset-enable-audited');
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

test('buildReportDataContract exposes quality gate baseline and custom rule status', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    const removedBaselineRule = config.optional_quality_checks.rules.find((rule) => rule.id === 'gate_routing_self_regression');
    assert.ok(removedBaselineRule);
    config.optional_quality_checks.rules = config.optional_quality_checks.rules
        .filter((rule) => rule.id !== removedBaselineRule.id)
        .map((rule) => rule.id === 'code_simplification'
            ? { ...rule, prompt: `${rule.prompt} Local edit.` }
            : rule);
    config.optional_quality_checks.rules.push({
        id: 'custom_focus',
        title: 'Custom focus',
        prompt: 'Check custom concern.',
        enabled: false
    });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    const canonicalized = report.quality_gate_tab.rules.find((rule) => rule.id === 'code_simplification');
    const restored = report.quality_gate_tab.rules.find((rule) => rule.id === removedBaselineRule.id);
    const custom = report.quality_gate_tab.rules.find((rule) => rule.id === 'custom_focus');
    assert.ok(canonicalized);
    assert.deepEqual(canonicalized.statuses, ['active']);
    assert.equal(canonicalized.source, 'baseline');
    assert.equal(canonicalized.prompt, 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.');
    assert.ok(restored);
    assert.equal(restored.present, true);
    assert.equal(restored.source, 'baseline');
    assert.deepEqual(restored.statuses, ['active']);
    assert.equal(restored.prompt, removedBaselineRule.prompt);
    assert.ok(custom);
    assert.equal(custom.source, 'custom');
    assert.deepEqual(custom.statuses, ['disabled']);
    assert.equal(report.quality_gate_tab.custom_rule_count, 1);
    assert.equal(report.quality_gate_tab.deleted_baseline_rule_count, 0);
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'missing');
    assert.deepEqual(report.quality_gate_tab.action_required_history, []);
    assert.equal(report.system_state.quality_baseline.status, 'attention');
    assert.deepEqual(
        (report.system_state.quality_baseline.value as { missing_shipped_rule_ids: string[] }).missing_shipped_rule_ids,
        ['gate_routing_self_regression']
    );
    assert.equal(report.system_state.quality_baseline.summary, '1 shipped quality rule(s) are missing from the installed workflow config.');
});

test('buildReportDataContract surfaces stale quality baseline diagnostics in System State', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    config.optional_quality_checks.baseline_version = '2026-06-25.t842';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    assert.equal(report.system_state.quality_baseline.status, 'attention');
    assert.match(report.system_state.quality_baseline.summary, /older than the shipped baseline/u);
    assert.equal(
        (report.system_state.quality_baseline.value as { installed_baseline_version: string }).installed_baseline_version,
        '2026-06-25.t842'
    );
});

test('buildSystemStateReport diagnoses missing shipped quality baseline ids without comparing custom rules', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    config.optional_quality_checks.rules = [
        ...config.optional_quality_checks.rules.filter((rule) => rule.id !== 'artifact_evidence_binding'),
        {
            id: 'custom_focus',
            title: 'Custom focus',
            prompt: 'Check custom concern.',
            enabled: true
        }
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    const value = report.system_state.quality_baseline.value as {
        missing_shipped_rule_ids: string[];
        custom_rule_count: number;
    };
    assert.equal(report.system_state.quality_baseline.status, 'attention');
    assert.deepEqual(value.missing_shipped_rule_ids, ['artifact_evidence_binding']);
    assert.equal(value.custom_rule_count, 1);
});

test('buildSystemStateReport treats missing installed quality baseline evidence as incomplete', () => {
    for (const variant of ['section', 'rules', 'version'] as const) {
        const repoRoot = makeTempRepo();
        writeTaskMd(repoRoot);
        writeWorkflowConfig(repoRoot);
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
        const shippedRuleCount = config.optional_quality_checks.rules.length;
        const shippedBaselineVersion = config.optional_quality_checks.baseline_version;

        if (variant === 'section') {
            delete (config as { optional_quality_checks?: unknown }).optional_quality_checks;
        } else if (variant === 'rules') {
            delete (config.optional_quality_checks as { rules?: unknown }).rules;
        } else {
            delete (config.optional_quality_checks as { baseline_version?: unknown }).baseline_version;
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        const report = buildReportDataContract({
            repoRoot,
            generatedAtUtc: '2026-05-16T00:00:00.000Z'
        });

        const value = report.system_state.quality_baseline.value as {
            installed_baseline_version: string | null;
            installed_baseline_rule_count: number;
            shipped_baseline_rule_count: number;
            missing_shipped_rule_ids: string[];
            custom_rule_count: number;
        };
        assert.equal(report.system_state.quality_baseline.status, 'attention', variant);
        assert.equal(value.installed_baseline_version, variant === 'rules' ? shippedBaselineVersion : null, variant);
        assert.equal(value.shipped_baseline_rule_count, shippedRuleCount, variant);
        assert.equal(value.custom_rule_count, 0, variant);

        if (variant === 'version') {
            assert.equal(value.installed_baseline_rule_count, shippedRuleCount, variant);
            assert.deepEqual(value.missing_shipped_rule_ids, [], variant);
        } else {
            assert.equal(value.installed_baseline_rule_count, 0, variant);
            assert.equal(value.missing_shipped_rule_ids.length, shippedRuleCount, variant);
        }
    }
});

test('buildQualityGateTab preserves legacy workflow-config-tab call signature', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const workflowConfigTab = buildWorkflowConfigTab(repoRoot);

    const qualityGateTab = buildQualityGateTab(workflowConfigTab);

    assert.equal(qualityGateTab.status, 'present');
    assert.equal(qualityGateTab.enabled, true);
    assert.equal(qualityGateTab.latest_check.evidence_status, 'missing');
    assert.deepEqual(qualityGateTab.action_required_history, []);
});

test('buildReportDataContract exposes quality gate evidence and action-required history', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const actionPreflightPath = writePreflight(repoRoot, 'T-099');
    const warnPreflightPath = writePreflight(repoRoot, 'T-100');
    fs.utimesSync(actionPreflightPath, new Date('2026-05-16T00:00:00.000Z'), new Date('2026-05-16T00:00:00.000Z'));
    fs.utimesSync(warnPreflightPath, new Date('2026-05-16T00:00:30.000Z'), new Date('2026-05-16T00:00:30.000Z'));
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-099',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        preflightPath: actionPreflightPath,
        actionsRequired: ['Extract parser helpers before review.']
    });
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-100',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z',
        preflightPath: warnPreflightPath,
        actionsTaken: ['Kept evidence scan bounded to recent artifacts.']
    });
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-099',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        actionsRequired: ['Extract parser helpers before review.']
    });
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-100',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z'
    });

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:03:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.task_id, 'T-100');
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'current');
    assert.equal(report.quality_gate_tab.latest_check.checklist_status, 'WARN');
    assert.equal(report.quality_gate_tab.latest_check.effect, 'warned');
    assert.equal(report.quality_gate_tab.latest_check.action_taken_count, 1);
    assert.equal(report.quality_gate_tab.latest_check.action_required_count, 0);
    assert.equal(report.quality_gate_tab.latest_check.answer_count, 1);
    assert.equal(report.quality_gate_tab.latest_check.changed_files_count, 1);
    assert.equal(report.quality_gate_tab.latest_check.timeline_event_count, 2);
    assert.ok(report.quality_gate_tab.latest_check.actions_taken.includes('Kept evidence scan bounded to recent artifacts.'));
    assert.equal(report.quality_gate_tab.action_required_history.length, 1);
    assert.equal(report.quality_gate_tab.action_required_history[0].task_id, 'T-099');
    assert.equal(report.quality_gate_tab.action_required_history[0].evidence_status, 'current');
    assert.deepEqual(report.quality_gate_tab.action_required_history[0].actions_required, ['Extract parser helpers before review.']);
});

test('buildReportDataContract bounds quality gate evidence discovery before parsing history', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    const oldTime = new Date('2026-05-15T00:00:00.000Z');
    const recentTime = new Date('2026-05-16T00:00:00.000Z');

    for (let index = 0; index < 120; index += 1) {
        const taskId = `T-OLD-${String(index).padStart(3, '0')}`;
        const preflightPath = writePreflight(repoRoot, taskId);
        writeQualityChecklistArtifact(repoRoot, {
            taskId,
            status: 'ACTION_REQUIRED',
            timestampUtc: '2027-01-01T00:00:00.000Z',
            preflightPath,
            actionsRequired: [`Old action ${index}`]
        });
        writeQualityChecklistTimelineEvent(repoRoot, {
            taskId,
            status: 'ACTION_REQUIRED',
            timestampUtc: '2026-05-15T00:00:00.000Z',
            actionsRequired: [`Old action ${index}`]
        });
        fs.utimesSync(preflightPath, oldTime, oldTime);
        fs.utimesSync(path.join(reviewsRoot, `${taskId}-quality-checklist.json`), oldTime, oldTime);
        fs.utimesSync(path.join(eventsRoot, `${taskId}.jsonl`), oldTime, oldTime);
    }

    const recentPreflightPath = writePreflight(repoRoot, 'T-RECENT');
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-RECENT',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        preflightPath: recentPreflightPath,
        actionsTaken: ['Kept quality evidence discovery bounded before parsing.']
    });
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-RECENT',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:01:00.000Z'
    });
    fs.utimesSync(recentPreflightPath, recentTime, recentTime);
    fs.utimesSync(path.join(reviewsRoot, 'T-RECENT-quality-checklist.json'), recentTime, recentTime);
    fs.utimesSync(path.join(eventsRoot, 'T-RECENT.jsonl'), recentTime, recentTime);

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:02:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.task_id, 'T-RECENT');
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'current');
    assert.equal(report.quality_gate_tab.latest_check.checklist_status, 'WARN');
    assert.equal(report.quality_gate_tab.latest_check.timeline_event_count, 80);
    assert.equal(report.quality_gate_tab.latest_check.timeline_event_count < 121, true);
});

test('buildReportDataContract preserves action-required history after same-task checklist overwrite', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot, 'T-100');
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-100',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        preflightPath,
        actionsRequired: ['Extract parser helpers before review.']
    });
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-100',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        actionsRequired: ['Extract parser helpers before review.']
    });
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-100',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z',
        preflightPath,
        actionsTaken: ['Fixed the action-required finding.']
    });
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-100',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z'
    });

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:03:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.task_id, 'T-100');
    assert.equal(report.quality_gate_tab.latest_check.checklist_status, 'WARN');
    assert.equal(report.quality_gate_tab.action_required_history.length, 1);
    assert.equal(report.quality_gate_tab.action_required_history[0].task_id, 'T-100');
    assert.equal(report.quality_gate_tab.action_required_history[0].evidence_status, 'stale');
    assert.deepEqual(report.quality_gate_tab.action_required_history[0].actions_required, ['Extract parser helpers before review.']);
});

test('buildReportDataContract rejects invalid quality gate evidence status', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot, 'T-100');
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-100',
        status: 'BROKEN',
        timestampUtc: '2026-05-16T00:02:00.000Z',
        preflightPath
    });

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:03:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'invalid');
    assert.equal(report.quality_gate_tab.latest_check.checklist_status, null);
    assert.equal(report.quality_gate_tab.latest_check.effect, 'invalid');
    assert.ok(report.quality_gate_tab.latest_check.stale_reasons.some((reason) =>
        reason.includes('Unsupported quality checklist status')
    ));
});

test('buildReportDataContract marks outside-repo quality gate preflight references stale', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-report-outside-preflight-'));
    const outsidePreflightPath = path.join(outsideRoot, 'T-100-preflight.json');
    const changedFiles = ['src/reports/report-data-contract.ts'];
    fs.writeFileSync(outsidePreflightPath, JSON.stringify({
        task_id: 'T-100',
        mode: 'FULL_PATH',
        detection_source: 'explicit_changed_files',
        changed_files: changedFiles,
        metrics: {
            changed_lines_total: 12,
            changed_files_sha256: sha256Text(changedFiles.join('\n')),
            scope_sha256: sha256Text('scope'),
            scope_content_sha256: sha256Text('content')
        }
    }, null, 2));
    writeQualityChecklistArtifactWithPreflightReference(repoRoot, {
        taskId: 'T-100',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z',
        preflightPath: outsidePreflightPath
    });

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:03:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.task_id, 'T-100');
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'stale');
    assert.equal(report.quality_gate_tab.latest_check.effect, 'stale');
    assert.ok(report.quality_gate_tab.latest_check.stale_reasons.some((reason) =>
        reason.includes('outside the repository')
    ));
});

test('buildReportDataContract marks outside-repo quality gate timeline artifact references stale', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-report-outside-artifact-'));
    const outsideArtifactPath = path.join(outsideRoot, 'T-100-quality-checklist.json');
    fs.writeFileSync(outsideArtifactPath, '{"status":"ACTION_REQUIRED"}\n', 'utf8');
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-100.jsonl');
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(timelinePath, `${JSON.stringify({
        schema_version: 2,
        task_id: 'T-100',
        timestamp_utc: '2026-05-16T00:02:00.000Z',
        event_type: 'QUALITY_CHECKLIST_RECORDED',
        outcome: 'FAIL',
        actor: 'gate',
        message: 'Quality checklist recorded: ACTION_REQUIRED.',
        details: {
            status: 'ACTION_REQUIRED',
            checklist_id: 'optional_quality_checks',
            artifact_path: outsideArtifactPath,
            artifact_hash: sha256File(outsideArtifactPath),
            action_required_count: 1,
            actions_required: ['Keep artifact probes inside the repository.'],
            changed_files_count: 1,
            changed_files_preview: ['src/reports/report-data-contract.ts']
        }
    })}\n`, 'utf8');

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:03:00.000Z'
    });

    assert.equal(report.quality_gate_tab.action_required_history.length, 1);
    assert.equal(report.quality_gate_tab.action_required_history[0].task_id, 'T-100');
    assert.equal(report.quality_gate_tab.action_required_history[0].evidence_status, 'stale');
    assert.deepEqual(report.quality_gate_tab.action_required_history[0].actions_required, [
        'Keep artifact probes inside the repository.'
    ]);
});

test('buildReportDataContract marks older quality gate evidence stale after newer preflight scope', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const oldPreflightPath = writePreflight(repoRoot, 'T-099', {
        changedFiles: ['src/reports/report-data-contract.ts'],
        scopeSeed: 'old-scope',
        contentSeed: 'old-content'
    });
    fs.utimesSync(oldPreflightPath, new Date('2026-05-16T00:01:00.000Z'), new Date('2026-05-16T00:01:00.000Z'));
    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-099',
        status: 'WARN',
        timestampUtc: '2026-05-16T00:02:00.000Z',
        preflightPath: oldPreflightPath
    });
    const newerPreflightPath = writePreflight(repoRoot, 'T-100', {
        changedFiles: ['src/reports/report-data-contract.ts', 'src/reports/report-data/quality-gate-evidence.ts'],
        scopeSeed: 'new-scope',
        contentSeed: 'new-content'
    });
    fs.utimesSync(newerPreflightPath, new Date('2026-05-16T00:04:00.000Z'), new Date('2026-05-16T00:04:00.000Z'));

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:05:00.000Z'
    });

    assert.equal(report.quality_gate_tab.latest_check.task_id, 'T-099');
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'stale');
    assert.equal(report.quality_gate_tab.latest_check.effect, 'stale');
    assert.ok(report.quality_gate_tab.latest_check.stale_reasons.some((reason) =>
        reason.includes('newer preflight artifact')
    ));
    assert.ok(report.quality_gate_tab.latest_check.stale_reasons.some((reason) =>
        reason.includes('latest preflight scope')
    ));
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
    assert.equal(report.system_state.overall.generated_at_utc, '2026-05-16T00:00:00.000Z');
    assert.ok(['ok', 'attention', 'error', 'unknown'].includes(report.system_state.overall.status));
    assert.equal(report.system_state.configuration_files.length, 4);
    assert.ok(report.system_state.configuration_files.every((entry) => entry.role === 'secondary'));
    assert.ok(report.system_state.configuration_files.some((entry) => entry.id === 'workflow-config' && entry.status === 'present'));
    assert.equal(report.system_state.task_queue.counts.total, 2);
    assert.equal(report.system_state.task_queue.next_task_id, 'T-100');
    assert.equal(report.system_state.workflow.full_suite_enabled, true);
    assert.equal(report.system_state.workflow.full_suite_command, 'npm test');
    assert.equal(report.system_state.workflow.full_suite_timeout_blocker, true);
    assert.equal(report.system_state.workflow.full_suite_timeout_retry_count, 1);
    assert.match(report.system_state.workflow.full_suite_timeout_forecast_label || '', /Recommended full-suite command timeout/u);
    assert.equal(report.system_state.workflow.task_reset_ready, false);
    assert.equal(report.system_state.project_memory.status, 'ok');
    assert.ok(report.system_state.signals.some((signal) => signal.id === 'protected-manifest'));
    assert.ok(report.system_state.signals.some((signal) => signal.id === 'active-task-timelines' && signal.status === 'ok'));
    assert.equal(report.tasks_tab.parser, 'canonical_active_queue_9_columns');
    assert.deepEqual(report.tasks_tab.rows.map((row) => row.task_id), ['T-100', 'T-101']);
    assert.equal(report.tasks_tab.rows[0].detail.detail_status, 'skipped');
    assert.equal(report.workflow_config_tab.status, 'present');
    assert.equal(report.quality_gate_tab.status, 'present');
    assert.equal(report.quality_gate_tab.enabled, true);
    assert.equal(report.quality_gate_tab.latest_check.evidence_status, 'missing');
    assert.equal(report.quality_gate_tab.baseline_version, report.quality_gate_tab.shipped_baseline_version);
    assert.ok(report.quality_gate_tab.rules.some((rule) => (
        rule.id === 'code_simplification'
        && rule.source === 'baseline'
        && rule.present
        && rule.statuses.includes('active')
    )));
    assert.equal(report.quality_gate_tab.deleted_baseline_rule_count, 0);
    assert.equal(report.init_settings_tab.init_answers_status, 'present');
    assert.equal(report.init_settings_tab.agent_init_state_status, 'present');
    assert.ok(report.init_settings_tab.init_answers.some((row) => row.id === 'SourceOfTruth' && row.value === 'Codex (AGENTS.md)' && row.file_path === 'AGENTS.md'));
    assert.ok(!report.init_settings_tab.init_answers.some((row) => row.id === 'CollectedVia'));
    assert.ok(report.init_settings_tab.init_answers.some((row) => row.id === 'ActiveAgentFiles' && row.value === 'AGENTS.md'));
    assert.ok(!report.init_settings_tab.agent_init_state.some((row) => row.id === 'UpdatedAt' || row.id.startsWith('ProjectMemory') || row.id === 'ActiveAgentFiles'));
    assert.deepEqual(report.init_settings_tab.ordinary_docs.paths, ['CHANGELOG.md']);
    assert.ok(report.init_settings_tab.commands.some((command) => command.id === 'reinit'));
    assert.ok(report.init_settings_tab.commands.some((command) => command.id === 'agent-init' && command.command.includes('AGENT_INIT_PROMPT.md')));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-mode' && row.value === 'update'));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-max-compact-summary-chars' && row.value === 12000));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-initialized' && row.value === true));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-validated' && row.value === true));
    assert.ok(report.project_memory_tab.status.some((row) => row.id === 'memory-read-first' && Array.isArray(row.value) && row.value.includes('live/docs/project-memory/README.md')));
    assert.match(report.project_memory_tab.advisory.prompt_path, /template[/\\]docs[/\\]prompts[/\\]project-memory-optimization\.md$/u);
    assert.equal(report.project_memory_tab.advisory.prompt_exists, true);
    assert.ok(report.project_memory_tab.settings.some((setting) => (
        setting.key === 'project_memory_maintenance.max_compact_summary_chars'
        && setting.flag === '--project-memory-max-compact-summary-chars'
        && setting.value === 12000
    )));
    assert.ok(report.project_memory_tab.files.some((file) => file.path.endsWith('project-memory/compact.md') && file.exists && file.size_bytes !== null));
    assert.match(report.project_memory_tab.settings_config_path, /workflow-config\.json$/u);
    assert.match(report.project_memory_tab.memory_directory_path, /project-memory$/u);
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Task execution'));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Review execution modes'));
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Backups'));
    assert.equal(report.backups_tab.auto_backup.enabled, false);
    assert.equal(report.backups_tab.auto_backup.keep_latest, 10);
    assert.deepEqual(report.backups_tab.rows, []);
    assert.equal(report.backups_tab.snapshots_root_exists, false);
    assert.match(report.backups_tab.workflow_config_path, /workflow-config\.json$/u);
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

test('buildReportDataContract reads latest full-suite pointer in System State', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const metricsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'metrics');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(metricsRoot, { recursive: true });
    for (let index = 0; index < 700; index += 1) {
        const oldArtifactPath = path.join(reviewsRoot, `T-OLD-${String(index).padStart(3, '0')}-full-suite-validation.json`);
        fs.writeFileSync(
            oldArtifactPath,
            JSON.stringify({
                status: 'PASSED',
                timed_out: false,
                warnings: [],
                timeout_policy: {
                    timeout_blocker: true,
                    timeout_retry_count: 1,
                    max_attempts: 2,
                    attempts: [],
                    attempts_exhausted: false,
                    warning_only_continuation: false
                }
            }),
            'utf8'
        );
        fs.utimesSync(oldArtifactPath, new Date('2026-05-15T00:00:00.000Z'), new Date('2026-05-15T00:00:00.000Z'));
    }
    const latestArtifactPath = path.join(reviewsRoot, 'T-ZZZ-full-suite-validation.json');
    fs.writeFileSync(
        latestArtifactPath,
        JSON.stringify({
            status: 'WARNED',
            timed_out: true,
            warnings: ['latest timeout warning'],
            timeout_policy: {
                timeout_blocker: false,
                timeout_retry_count: 2,
                max_attempts: 3,
                attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
                attempts_exhausted: true,
                warning_only_continuation: true
            }
        }),
        'utf8'
    );
    fs.utimesSync(latestArtifactPath, new Date('2026-05-16T00:00:00.000Z'), new Date('2026-05-16T00:00:00.000Z'));
    fs.writeFileSync(
        path.join(metricsRoot, 'full-suite-validation-latest.json'),
        JSON.stringify({
            schema_version: 1,
            task_id: 'T-ZZZ',
            status: 'WARNED',
            artifact_path: latestArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: 'fixture',
            artifact_transaction_id: 'fixture',
            updated_at_utc: '2026-05-16T00:00:00.000Z'
        }),
        'utf8'
    );

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    assert.equal(report.system_state.workflow.full_suite_timeout_blocker, true);
    assert.equal(report.system_state.workflow.full_suite_timeout_retry_count, 1);
    assert.equal(report.system_state.workflow.full_suite_timeout_attempts_count, 3);
    assert.equal(report.system_state.workflow.full_suite_timeout_attempts_exhausted, true);
    assert.equal(report.system_state.workflow.full_suite_timeout_warning_only_continuation, true);
    assert.equal(report.system_state.workflow.full_suite_timeout_latest_warning, 'latest timeout warning');
    assert.match(report.system_state.workflow.full_suite_timeout_forecast_label || '', /Recommended full-suite command timeout/u);
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
    assert.equal(detail.full_suite_validation.timeout_blocker, true);
    assert.equal(detail.full_suite_validation.timeout_retry_count, 1);
    assert.equal(detail.full_suite_validation.timeout_max_attempts, 2);
    assert.deepEqual(detail.full_suite_validation.timeout_attempts, []);
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
    assert.equal(detail.full_suite_validation.timeout_blocker, true);
    assert.equal(detail.full_suite_validation.timeout_retry_count, 1);
    assert.equal(detail.full_suite_validation.timeout_max_attempts, 2);
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

test('buildReportSnapshotFingerprint changes when workflow config audit log changes', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const before = buildReportSnapshotFingerprint(repoRoot);
    const auditPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(auditPath, `${JSON.stringify({
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: '2026-06-19T04:00:00.000Z',
        actor: 'operator_command',
        command: 'workflow set',
        changed_fields: ['task_reset.enabled'],
        before_sha256: 'before',
        after_sha256: 'after'
    })}\n`, 'utf8');
    const after = buildReportSnapshotFingerprint(repoRoot);
    assert.notEqual(before, after);
});

test('buildReportSnapshotFingerprint changes when Garda switch state changes', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent instructions\n', 'utf8');

    const before = buildReportSnapshotFingerprint(repoRoot);
    const switchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'state.json');
    fs.mkdirSync(path.dirname(switchPath), { recursive: true });
    fs.writeFileSync(switchPath, JSON.stringify({ mode: 'off' }, null, 2), 'utf8');
    const after = buildReportSnapshotFingerprint(repoRoot);

    assert.notEqual(before, after);
});

test('buildReportSnapshotFingerprint changes when System State runtime evidence changes', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const before = buildReportSnapshotFingerprint(repoRoot);

    const metricsPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'metrics',
        'full-suite-validation-duration-history.json'
    );
    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, JSON.stringify([{ duration_ms: 1000 }], null, 2), 'utf8');
    const afterMetrics = buildReportSnapshotFingerprint(repoRoot);

    const lockPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'locks', 'report.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'locked\n', 'utf8');
    const afterLock = buildReportSnapshotFingerprint(repoRoot);

    assert.notEqual(before, afterMetrics);
    assert.notEqual(afterMetrics, afterLock);
});

test('buildReportSnapshotFingerprint changes when quality gate evidence changes', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    const preflightPath = writePreflight(repoRoot, 'T-100');
    const before = buildReportSnapshotFingerprint(repoRoot);

    writeQualityChecklistArtifact(repoRoot, {
        taskId: 'T-100',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        preflightPath,
        actionsRequired: ['Extract parser helpers before review.']
    });
    const afterArtifact = buildReportSnapshotFingerprint(repoRoot);
    writeQualityChecklistTimelineEvent(repoRoot, {
        taskId: 'T-100',
        status: 'ACTION_REQUIRED',
        timestampUtc: '2026-05-16T00:01:00.000Z',
        actionsRequired: ['Extract parser helpers before review.']
    });
    const afterTimeline = buildReportSnapshotFingerprint(repoRoot);

    assert.notEqual(before, afterArtifact);
    assert.notEqual(afterArtifact, afterTimeline);
});

test('buildReportSnapshotFingerprint and System State bound large runtime artifact scans', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'archive');
    fs.mkdirSync(eventsRoot, { recursive: true });
    for (let index = 0; index < 600; index += 1) {
        fs.writeFileSync(path.join(eventsRoot, `event-${String(index).padStart(3, '0')}.jsonl`), '{}\n', 'utf8');
    }

    const fingerprint = buildReportSnapshotFingerprint(repoRoot);
    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });
    const runtimeValue = report.system_state.runtime.artifact_scan.value as {
        scan_truncated?: boolean;
        scan_limit?: number;
    };

    assert.match(fingerprint, /scan_truncated:512/u);
    assert.equal(report.system_state.runtime.artifact_scan.status, 'attention');
    assert.equal(runtimeValue.scan_truncated, true);
    assert.equal(runtimeValue.scan_limit, 512);
});

test('buildReportDataContract classifies stale locks and incomplete timelines in System State', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);
    writeStaleTaskEventLock(repoRoot, 'T-100');
    writePartialTaskTimeline(repoRoot, 'T-100');

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });
    const lockValue = report.system_state.runtime.stale_locks.value as {
        stale_count?: number;
        stale_locks?: Array<{ task_id?: string | null; stale_reason?: string | null }>;
    };
    const timelineValue = report.system_state.runtime.incomplete_timeline.value as {
        warnings?: string[];
        warning_tasks?: Array<{ task_id?: string | null; kind?: string; details?: string[] }>;
        warnings_truncated?: boolean;
        warning_count?: number;
    };

    assert.equal(report.system_state.runtime.stale_locks.status, 'attention');
    assert.match(
        report.system_state.runtime.stale_locks.remediation || '',
        /garda repair locks --target-root "\." --cleanup-stale --confirm/u
    );
    assert.doesNotMatch(report.system_state.runtime.stale_locks.remediation || '', /doctor --target-root/u);
    assert.equal(lockValue.stale_count, 1);
    assert.ok(lockValue.stale_locks?.some((lock) => lock.task_id === 'T-100' && lock.stale_reason === 'owner_dead'));
    assert.equal(report.system_state.runtime.incomplete_timeline.status, 'attention');
    assert.match(report.system_state.runtime.incomplete_timeline.summary, /T-100/u);
    assert.match(
        report.system_state.runtime.incomplete_timeline.remediation || '',
        /does not repair missing or invalid task events/u
    );
    assert.doesNotMatch(
        report.system_state.runtime.incomplete_timeline.remediation || '',
        /garda repair rebuild-indexes --target-root "\." --confirm/u
    );
    assert.ok(timelineValue.warnings?.some((warning) => warning.includes('INCOMPLETE timeline: T-100.jsonl')));
    assert.ok(timelineValue.warning_tasks?.some((warning) =>
        warning.task_id === 'T-100'
        && warning.kind === 'INCOMPLETE'
        && (warning.details || []).includes('COMPLETION_GATE_PASSED')
    ));
    assert.ok(['attention', 'error'].includes(report.system_state.overall.status));
});

test('buildReportDataContract bounds timeline warning details while preserving totals', () => {
    const repoRoot = makeTempRepo();
    writeTaskMdWithActiveRows(repoRoot, Array.from({ length: 12 }, (_, index) => {
        const taskId = `T-${200 + index}`;
        return `| ${taskId} | 🟨 IN_PROGRESS | P2 | ui/report | Timeline warning ${index} | gpt-5.4 | 2026-05-16 | balanced | Active incomplete timeline |`;
    }));
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);
    for (let index = 0; index < 12; index += 1) {
        writePartialTaskTimeline(repoRoot, `T-${200 + index}`);
    }

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });
    const timelineValue = report.system_state.runtime.incomplete_timeline.value as {
        warnings?: string[];
        warning_tasks?: Array<{ task_id?: string | null; kind?: string; details?: string[]; details_omitted_count?: number }>;
        warnings_truncated?: boolean;
        warning_count?: number;
    };

    assert.equal(report.system_state.runtime.incomplete_timeline.status, 'attention');
    assert.match(
        report.system_state.runtime.incomplete_timeline.summary,
        /12 task timeline warning\(s\) detected; affected: T-200, T-201, T-202, T-203, T-204, \+7 more\./u
    );
    assert.equal(timelineValue.warning_count, 12);
    assert.equal(timelineValue.warnings_truncated, true);
    assert.equal(timelineValue.warnings?.length, 10);
    assert.equal(timelineValue.warning_tasks?.length, 10);
    assert.ok(timelineValue.warning_tasks?.some((warning) => warning.task_id === 'T-200'));
    assert.equal(timelineValue.warning_tasks?.some((warning) => warning.task_id === 'T-210'), false);
});

test('buildReportDataContract bounds per-timeline warning details', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAndProjectMemory(repoRoot);
    writeMalformedTaskTimeline(repoRoot, 'T-300', 8);

    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });
    const timelineValue = report.system_state.runtime.incomplete_timeline.value as {
        warning_tasks?: Array<{ task_id?: string | null; kind?: string; details?: string[]; details_omitted_count?: number }>;
    };
    const warning = timelineValue.warning_tasks?.find((item) => item.task_id === 'T-300');

    assert.equal(warning?.kind, 'INVALID');
    assert.equal(warning?.details?.length, 5);
    assert.equal(warning?.details_omitted_count, 3);
    assert.ok(warning?.details?.every((detail) => detail.includes('invalid JSON')));
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
