import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { buildStaticHtmlReport, renderStaticHtmlReport } from '../../../src/reports/static-html-report';
import { buildReportDataContract } from '../../../src/reports/report-data-contract';

type StaticFakeListener = (event?: { key?: string }) => void;

class StaticFakeClassList {
    private readonly classes = new Set<string>();

    add(className: string): void {
        this.classes.add(className);
    }

    remove(className: string): void {
        this.classes.delete(className);
    }

    toggle(className: string, force?: boolean): void {
        if (force === true) {
            this.classes.add(className);
            return;
        }
        if (force === false) {
            this.classes.delete(className);
            return;
        }
        if (this.classes.has(className)) {
            this.classes.delete(className);
            return;
        }
        this.classes.add(className);
    }
}

class StaticFakeElement {
    readonly dataset: Record<string, string> = {};
    readonly classList = new StaticFakeClassList();
    readonly listeners = new Map<string, StaticFakeListener[]>();
    textContent = '';
    innerHTML = '';

    constructor(readonly id: string) {}

    addEventListener(eventName: string, listener: StaticFakeListener): void {
        const listeners = this.listeners.get(eventName) || [];
        listeners.push(listener);
        this.listeners.set(eventName, listeners);
    }

    dispatch(eventName: string, event?: { key?: string }): void {
        for (const listener of this.listeners.get(eventName) || []) {
            listener(event);
        }
    }

    setAttribute(): void {
        // The static script toggles tab ARIA state; these tests inspect task detail rendering only.
    }

    replaceChildren(node: StaticFakeFragment): void {
        this.innerHTML = node.render();
    }
}

class StaticFakeFragment {
    private readonly elements = new Map<string, StaticFakeElement>();

    querySelector(selector: string): StaticFakeElement {
        if (!this.elements.has(selector)) {
            this.elements.set(selector, new StaticFakeElement(selector));
        }
        return this.elements.get(selector) as StaticFakeElement;
    }

    render(): string {
        return Array.from(this.elements.values())
            .map((element) => `${element.textContent}${element.innerHTML}`)
            .join('');
    }
}

class StaticFakeTemplate extends StaticFakeElement {
    readonly content = {
        cloneNode: () => new StaticFakeFragment()
    };
}

function extractStaticScript(html: string): string {
    const match = html.match(/<script>\n([\s\S]*)\n<\/script>\n<\/body>/u);
    assert.ok(match, 'expected static inline script');
    return match[1];
}

function extractReportDataJson(html: string): string {
    const match = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/u);
    assert.ok(match, 'expected embedded report data');
    return match[1];
}

function executeStaticTaskClient(html: string): StaticFakeElement {
    const detailElement = new StaticFakeElement('task-detail');
    const reportDataElement = new StaticFakeElement('report-data');
    reportDataElement.textContent = extractReportDataJson(html);
    const rows = [0, 1].map((index) => {
        const row = new StaticFakeElement(`row-${index}`);
        row.dataset.taskIndex = String(index);
        return row;
    });
    const elements: Record<string, StaticFakeElement> = {
        'report-data': reportDataElement,
        'task-detail': detailElement,
        'task-detail-template': new StaticFakeTemplate('task-detail-template'),
        'tab-tasks': new StaticFakeElement('tab-tasks'),
        'tab-workflow': new StaticFakeElement('tab-workflow'),
        'tab-init-settings': new StaticFakeElement('tab-init-settings'),
        'tab-project-memory': new StaticFakeElement('tab-project-memory'),
        'tab-backups': new StaticFakeElement('tab-backups'),
        'tab-instructions': new StaticFakeElement('tab-instructions')
    };
    const tabs = ['tasks', 'workflow', 'init-settings', 'project-memory', 'backups', 'instructions'].map((tabId) => {
        const tab = new StaticFakeElement(`tab-button-${tabId}`);
        tab.dataset.tab = tabId;
        return tab;
    });
    vm.runInNewContext(extractStaticScript(html), {
        document: {
            getElementById: (id: string) => elements[id] || new StaticFakeElement(id),
            querySelectorAll: (selector: string) => {
                if (selector === '.tab') {
                    return tabs;
                }
                if (selector === '.panel') {
                    return Object.values(elements).filter((element) => element.id.startsWith('tab-'));
                }
                if (selector === 'tr[data-task-index]') {
                    return rows;
                }
                return [];
            }
        },
        JSON,
        Number,
        String,
        encodeURI
    });
    rows[0].dispatch('click');
    return detailElement;
}

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

function writeInitAnswers(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent instructions\n');
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({ SourceOfTruth: 'Codex' }, null, 2));
}

function writeProjectMemoryReadme(repoRoot: string): void {
    const memoryPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'README.md');
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, '# Project memory\n');
    const promptPath = path.join(repoRoot, 'garda-agent-orchestrator', 'template', 'docs', 'prompts', 'project-memory-optimization.md');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, '# Project memory optimization prompt\n');
}

test('renderStaticHtmlReport includes tabs, escaped task rows, and embedded data', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);
    writeInitAnswers(repoRoot);
    writeProjectMemoryReadme(repoRoot);

    const report = buildReportDataContract({ repoRoot, generatedAtUtc: '2026-05-16T00:00:00.000Z' });
    report.tasks_tab.rows[0].detail.artifact_links = [{
        kind: 'compile-output',
        path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log',
        exists: true,
        sha256: 'abc123'
    }];
    report.tasks_tab.rows[0].detail.full_suite_validation = {
        ...report.tasks_tab.rows[0].detail.full_suite_validation,
        state: 'passed',
        freshness: 'current',
        enabled: true,
        required: true,
        status: 'PASSED',
        command: 'npm test',
        duration_ms: 123456,
        duration_human: '2m 3.5s',
        timed_out: false,
        exit_code: 0,
        artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-full-suite-validation.json',
        artifact_exists: true,
        output_artifact_path: 'C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-full-suite-output.log',
        compact_summary: ['# tests 10'],
        timeout_forecast: {
            history_path: 'runtime/metrics/full-suite-validation-duration-history.json',
            sample_count: 5,
            average_duration_seconds: 343.2,
            high_watermark_duration_seconds: 396.3,
            recommended_timeout_seconds: 476,
            safety_margin_seconds: 79.7,
            recommendation_source: 'history',
            configured_timeout_seconds: 600,
            warning: null
        },
        timeout_forecast_label: 'Recommended full-suite command timeout: 476s (last 5 run(s) avg 343.2s; max 396.3s; safety margin over max +79.7s = 20% but at least 30s).'
    };
    const html = renderStaticHtmlReport(report);

    assert.ok(html.includes('data-tab="tasks"'));
    assert.ok(html.includes('data-tab="workflow"'));
    assert.ok(html.includes('data-tab="init-settings"'));
    assert.ok(html.includes('data-tab="project-memory"'));
    assert.ok(html.includes('data-tab="backups"'));
    assert.ok(html.includes('data-tab="instructions"'));
    assert.ok(html.includes('id="tab-init-settings"'));
    assert.ok(html.includes('id="tab-project-memory"'));
    assert.ok(html.includes('id="tab-backups"'));
    assert.ok(html.includes('read-only in static HTML'));
    assert.ok(!html.includes('data-tab="actions"'));
    assert.ok(html.includes('Build &lt;HTML&gt; report'));
    assert.ok(html.includes('toArtifactHref(item.path)'));
    assert.ok(html.includes('<a href="'));
    assert.ok(html.includes('href="../../../AGENTS.md"'));
    assert.ok(html.includes('href="../../live/docs/project-memory/README.md"'));
    assert.ok(html.includes('Project Memory Optimization'));
    assert.ok(html.includes('garda-agent-orchestrator/template/docs/prompts/project-memory-optimization.md'));
    assert.ok(html.includes('href="../../template/docs/prompts/project-memory-optimization.md"'));
    assert.ok(!html.includes('href="AGENTS.md"'));
    assert.ok(html.includes('C:/repo/garda-agent-orchestrator/runtime/reviews/T-100-compile-output.log'));
    assert.ok(html.includes('Full-suite Validation'));
    assert.ok(html.includes('T-100-full-suite-validation.json'));
    assert.ok(html.includes('2m 3.5s'));
    assert.ok(html.includes('Average duration'));
    assert.ok(html.includes('Recommended timeout'));
    assert.ok(html.includes('fullSuiteDurationSeconds(forecast.average_duration_seconds)'));
    assert.ok(html.includes('"average_duration_seconds":343.2'));
    assert.ok(html.includes('"recommended_timeout_seconds":476'));
    assert.ok(html.includes('"task_id":"T-100"'));
    assert.ok(!html.includes('Must stay out of the upper queue'));
    const renderedDetail = executeStaticTaskClient(html);

    assert.ok(renderedDetail.innerHTML.includes('<th>Configured timeout</th><td>10m</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Average duration</th><td>5m 43.2s</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>High-watermark duration</th><td>6m 36.3s</td>'));
    assert.ok(renderedDetail.innerHTML.includes('<th>Recommended timeout</th><td>7m 56s</td>'));

    report.tasks_tab.rows[0].detail.full_suite_validation = {
        ...report.tasks_tab.rows[0].detail.full_suite_validation,
        timeout_forecast: {
            history_path: 'runtime/metrics/full-suite-validation-duration-history.json',
            sample_count: 0,
            average_duration_seconds: null,
            high_watermark_duration_seconds: null,
            recommended_timeout_seconds: 600,
            safety_margin_seconds: null,
            recommendation_source: 'config_timeout',
            configured_timeout_seconds: 600,
            warning: null
        },
        timeout_forecast_label: 'Recommended full-suite command timeout: 600s (no recent matching full-suite duration history; using configured timeout).'
    };
    const noHistoryHtml = renderStaticHtmlReport(report);

    assert.ok(noHistoryHtml.includes('Configured timeout'));
    assert.ok(noHistoryHtml.includes('Average duration'));
    assert.ok(noHistoryHtml.includes('High-watermark duration'));
    assert.ok(noHistoryHtml.includes('Recommended timeout'));
    assert.ok(noHistoryHtml.includes('"average_duration_seconds":null'));
    assert.ok(noHistoryHtml.includes('"high_watermark_duration_seconds":null'));
    assert.ok(noHistoryHtml.includes('"recommendation_source":"config_timeout"'));
    assert.ok(noHistoryHtml.includes('"recommended_timeout_seconds":600'));
    const noHistoryRenderedDetail = executeStaticTaskClient(noHistoryHtml);

    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Configured timeout</th><td>10m</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Average duration</th><td>-</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>High-watermark duration</th><td>-</td>'));
    assert.ok(noHistoryRenderedDetail.innerHTML.includes('<th>Recommended timeout</th><td>10m</td>'));
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
    assert.equal(result.detailed_task_count, 0);
    assert.equal(result.skipped_detail_count, 2);
    assert.equal(result.max_detailed_tasks, 0);
    assert.match(result.url, /^file:\/\//);
    assert.ok(result.output_path.endsWith(path.join('garda-agent-orchestrator', 'runtime', 'reports', 'garda-report.html')));
    assert.ok(fs.existsSync(result.output_path));
    assert.match(fs.readFileSync(result.output_path, 'utf8'), /Garda HTML Report/);
});

test('buildStaticHtmlReport can skip deep task details for fast snapshots', () => {
    const repoRoot = makeTempRepo();
    writeTaskMd(repoRoot);
    writeWorkflowConfig(repoRoot);

    const result = buildStaticHtmlReport({
        repoRoot,
        generatedAtUtc: '2026-05-16T00:00:00.000Z',
        maxDetailedTasks: 0
    });

    assert.equal(result.task_count, 2);
    assert.equal(result.detailed_task_count, 0);
    assert.equal(result.skipped_detail_count, 2);
    assert.equal(result.max_detailed_tasks, 0);
    const html = fs.readFileSync(result.output_path, 'utf8');
    assert.ok(html.includes('Deep task details are lazy'));
    assert.ok(html.includes('<td>skipped</td>'));
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
