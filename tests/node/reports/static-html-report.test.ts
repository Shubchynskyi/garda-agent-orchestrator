import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { buildStaticHtmlReport, renderStaticHtmlReport } from '../../../src/reports/static-html-report';
import { buildReportDataContract } from '../../../src/reports/report-data-contract';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-static-html-report-'));
}

function writeTaskMd(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | IN_PROGRESS | P2 | ui/report | Build <HTML> report | gpt-5.4 | 2026-05-16 | balanced | Uses logs only |',
        '| T-101 | TODO | P2 | ui/report | Next report task | gpt-5.4 | 2026-05-16 | balanced | Next task |',
        '',
        '## User Summary (RU)',
        '| ID | Summary |',
        '|---|---|',
        '| T-999 | Must stay out of the upper queue |'
    ].join('\n'));
}

function writeWorkflowConfig(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
}

test('renderStaticHtmlReport includes tabs, escaped task rows, and embedded data', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const report = buildReportDataContract({ repoRoot, generatedAtUtc: '2026-05-16T00:00:00.000Z' });
    report.tasks_tab.rows[0].detail.artifact_links = [{
        kind: 'compile-output',
        path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log',
        exists: true,
        sha256: 'abc123'
    }];
    const html = renderStaticHtmlReport(report);

    assert.ok(html.includes('data-tab="tasks"'));
    assert.ok(html.includes('data-tab="workflow"'));
    assert.ok(html.includes('data-tab="instructions"'));
    assert.ok(html.includes('Build &lt;HTML&gt; report'));
    assert.ok(html.includes('toArtifactHref(item.path)'));
    assert.ok(html.includes('<a href="'));
    assert.ok(html.includes('C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log'));
    assert.ok(html.includes('"task_id":"T-100"'));
    assert.ok(!html.includes('Must stay out of the upper queue'));
});

test('buildStaticHtmlReport writes default runtime report and returns a browser URL', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z'
    });

    assert.equal(result.task_count, 2);
    assert.match(result.url, /^file:\/\//);
    assert.ok(result.output_path.endsWith(path.join('garda-agent-orchestrator', 'runtime', 'reports', 'garda-report.html')));
    assert.ok(fs.existsSync(result.output_path));
    assert.match(fs.readFileSync(result.output_path, 'utf8'), /Garda HTML Report/);
});

test('buildStaticHtmlReport can write timestamped snapshots', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        snapshot: true
    });

    assert.equal(result.latest_path, result.output_path);
    assert.equal(result.latest_url, result.url);
    assert.ok(result.snapshot_path?.endsWith(path.join('snapshots', 'garda-report-20260516T000000000Z.html')));
    assert.match(result.snapshot_url || '', /^file:\/\//);
    assert.ok(result.snapshot_path && fs.existsSync(result.snapshot_path));
});

test('buildStaticHtmlReport prunes old snapshots when retention is set', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        snapshot: true
    });
    buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:01:00.000Z',
        snapshot: true
    });
    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:02:00.000Z',
        snapshot: true,
        snapshotRetention: 2
    });

    assert.equal(result.deleted_snapshot_paths.length, 1);
    assert.ok(result.deleted_snapshot_paths[0].endsWith('garda-report-20260516T000000000Z.html'));
    const snapshotDir = path.dirname(result.snapshot_path || '');
    assert.deepEqual(fs.readdirSync(snapshotDir).sort(), [
        'garda-report-20260516T000100000Z.html',
        'garda-report-20260516T000200000Z.html'
    ]);
});
