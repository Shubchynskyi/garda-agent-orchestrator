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
    assert.match(fullSuite.command, /garda workflow set --full-suite on\|off/);
    assert.match(fullSuite.description, /full-suite/i);
});

test('buildReportDataContract exposes tasks, workflow config, and instruction tabs', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

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
    assert.ok(report.instructions_tab.entries.some((entry) => entry.title === 'Task execution'));
    assert.ok(report.tasks_tab.rows[0].detail.unavailable.some((entry) => entry.scope === 'task:T-100:detail'));
});

test('buildReportDataContract bounds deep task detail collection', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

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
