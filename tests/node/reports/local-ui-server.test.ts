import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as vm from 'node:vm';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import {
    DEFAULT_UI_HOST,
    startLocalUiServer
} from '../../../src/reports/local-ui-server';

type FakeListener = () => void | Promise<void>;

class FakeClassList {
    private readonly classes = new Set<string>();

    constructor(initialClasses: string[] = []) {
        for (const className of initialClasses) {
            this.classes.add(className);
        }
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

class FakeElement {
    readonly listeners = new Map<string, FakeListener[]>();
    readonly dataset: Record<string, string> = {};
    readonly classList: FakeClassList;
    textContent = '';
    value = '';
    hidden = false;
    private buttonCacheHtml = '';
    private buttonCache: FakeElement[] = [];
    private html = '';

    constructor(readonly id: string, initialClasses: string[] = []) {
        this.classList = new FakeClassList(initialClasses);
    }

    get innerHTML(): string {
        return this.html;
    }

    set innerHTML(value: string) {
        this.html = value;
    }

    addEventListener(eventName: string, listener: FakeListener): void {
        const listeners = this.listeners.get(eventName) || [];
        listeners.push(listener);
        this.listeners.set(eventName, listeners);
    }

    async dispatch(eventName: string): Promise<void> {
        for (const listener of this.listeners.get(eventName) || []) {
            await listener();
        }
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== 'button[data-task-id]'
            && selector !== 'button[data-action-id]'
            && selector !== 'button[data-setting-id]'
            && selector !== 'button[data-task-action-id]'
            && selector !== 'button[data-instruction-tab]') {
            return [];
        }
        if (this.buttonCacheHtml !== this.innerHTML) {
            this.buttonCacheHtml = this.innerHTML;
            const attributeName = selector === 'button[data-task-id]'
                ? 'task-id'
                : selector === 'button[data-action-id]'
                    ? 'action-id'
                    : selector === 'button[data-setting-id]'
                        ? 'setting-id'
                        : selector === 'button[data-task-action-id]'
                            ? 'task-action-id'
                            : 'instruction-tab';
            const dataKey = selector === 'button[data-task-id]'
                ? 'taskId'
                : selector === 'button[data-action-id]'
                    ? 'actionId'
                    : selector === 'button[data-setting-id]'
                        ? 'settingId'
                        : selector === 'button[data-task-action-id]'
                            ? 'taskActionId'
                            : 'instructionTab';
            const modePattern = /data-action-mode="([^"]+)"/u;
            const settingModePattern = /data-setting-mode="([^"]+)"/u;
            const taskActionModePattern = /data-task-action-mode="([^"]+)"/u;
            this.buttonCache = Array.from(this.innerHTML.matchAll(new RegExp(`data-${attributeName}="([^"]+)"`, 'gu')), (match) => {
                const button = new FakeElement(`button-${match[1]}`);
                button.dataset[dataKey] = match[1];
                const buttonHtml = this.innerHTML.slice(Math.max(0, match.index || 0), this.innerHTML.indexOf('</button>', match.index || 0));
                const modeMatch = buttonHtml.match(modePattern);
                if (modeMatch) {
                    button.dataset.actionMode = modeMatch[1];
                }
                const settingModeMatch = buttonHtml.match(settingModePattern);
                if (settingModeMatch) {
                    button.dataset.settingMode = settingModeMatch[1];
                }
                const taskActionModeMatch = buttonHtml.match(taskActionModePattern);
                if (taskActionModeMatch) {
                    button.dataset.taskActionMode = taskActionModeMatch[1];
                }
                return button;
            });
        }
        return this.buttonCache;
    }
}

function createFakeDocument(): {
    elements: Record<string, FakeElement>;
    getElementById: (id: string) => FakeElement;
    querySelectorAll: (selector: string) => FakeElement[];
} {
    const elements: Record<string, FakeElement> = {};
    for (const id of [
        'tasks',
        'detail',
        'meta',
        'warnings',
        'overview',
        'garda-switch-panel',
        'workflow',
        'workflow-config-path',
        'settings-editor',
        'setting-status',
        'init-settings',
        'project-memory',
        'instructions',
        'actions',
        'action-status',
        'session-summary',
        'session-countdown',
        'session-activity',
        'session-shutdown',
        'plan-modal',
        'plan-modal-body',
        'plan-modal-close',
        'language-select',
        'ui-notice',
        'task-search',
        'status-filter',
        'priority-filter',
        'tasks-tab',
        'workflow-tab',
        'init-settings-tab',
        'project-memory-tab',
        'instructions-tab',
        'actions-tab',
        'task-detail-panel'
    ]) {
        elements[id] = new FakeElement(id, id.endsWith('-tab') ? ['tab'] : []);
    }
    elements['workflow-tab'].hidden = true;
    elements['init-settings-tab'].hidden = true;
    elements['project-memory-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;
    elements['actions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'init-settings-tab', 'project-memory-tab', 'instructions-tab', 'actions-tab'].map((tabId, index) => {
        const button = new FakeElement(`nav-${tabId}`, index === 0 ? ['active'] : []);
        button.dataset.tab = tabId;
        return button;
    });

    return {
        elements,
        getElementById: (id: string) => {
            elements[id] = elements[id] || new FakeElement(id);
            return elements[id];
        },
        querySelectorAll: (selector: string) => {
            if (selector === 'nav button[data-tab]') {
                return navButtons;
            }
            if (selector === '.tab') {
                return [
                    elements['tasks-tab'],
                    elements['workflow-tab'],
                    elements['init-settings-tab'],
                    elements['project-memory-tab'],
                    elements['instructions-tab'],
                    elements['actions-tab']
                ];
            }
            return [];
        }
    };
}

function extractDashboardScript(html: string): string {
    const match = html.match(/<script>([\s\S]*)<\/script>/u);
    assert.ok(match, 'expected inline dashboard script');
    return match[1];
}

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-ui-server-'));
}

function writeRepo(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | TODO | P2 | ui/report | Build UI | gpt-5.4 | 2026-05-17 | balanced | Uses lazy details |'
    ].join('\n'));
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
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
        UpdatedAt: '2026-05-17T00:00:00.000Z',
        OrchestratorVersion: '1.1.0',
        AssistantLanguage: 'Russian',
        SourceOfTruth: 'Codex',
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: true,
        SkillsPromptCompleted: true,
        OrdinaryDocPathsConfirmed: true,
        OrdinaryDocPaths: [],
        VerificationPassed: true,
        ManifestValidationPassed: true,
        ActiveAgentFiles: ['AGENTS.md'],
        LastSeededFullSuiteCommand: 'npm test',
        ProjectMemoryInitialized: true,
        ProjectMemoryValidated: true,
        ProjectMemoryMode: 'strict',
        ProjectMemoryDir: 'live/docs/project-memory',
        ProjectMemoryReadFirst: ['live/docs/project-memory/README.md', 'live/docs/project-memory/compact.md'],
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

function setTaskResetEnabled(repoRoot: string, enabled: boolean): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    parsed.task_reset.enabled = enabled;
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
}

function writeTaskQueue(repoRoot: string, taskId: string, title: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | TODO | P2 | ui/report | ${title} | gpt-5.4 | 2026-05-17 | balanced | Uses lazy details |`
    ].join('\n'));
}

function reservePort(): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, DEFAULT_UI_HOST, () => resolve(server));
    });
}

function reserveSpecificPort(port: number): Promise<net.Server | null> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        const onError = (error: Error & { code?: string }) => {
            server.removeListener('listening', onListening);
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
                resolve(null);
                return;
            }
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, DEFAULT_UI_HOST);
    });
}

async function reserveConsecutivePortPair(): Promise<{ reserved: net.Server; busyPort: number; nextPort: number }> {
    for (let port = 41000; port < 41100; port += 1) {
        const reserved = await reserveSpecificPort(port);
        if (!reserved) {
            continue;
        }
        const next = await reserveSpecificPort(port + 1);
        if (next) {
            await closeNetServer(next);
            return { reserved, busyPort: port, nextPort: port + 1 };
        }
        await closeNetServer(reserved);
    }
    throw new Error('Unable to reserve consecutive local UI test ports.');
}

function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

test('local UI server exposes report and lazy task detail endpoints', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        const reportResponse = await fetch(`${server.url}api/report`);
        assert.equal(reportResponse.status, 200);
        const report = await reportResponse.json() as {
            tasks_tab: { rows: Array<{ task_id: string; detail: { detail_status: string } }> };
            workflow_config_tab: { settings: unknown[] };
            instructions_tab: { entries: unknown[] };
            unavailable: unknown[];
        };
        assert.equal(report.tasks_tab.rows[0].task_id, 'T-100');
        assert.equal(report.tasks_tab.rows[0].detail.detail_status, 'skipped');
        assert.ok(report.workflow_config_tab.settings.length > 0);
        assert.ok(report.instructions_tab.entries.length > 0);
        assert.equal(report.unavailable.length, 0);

        const detailResponse = await fetch(`${server.url}api/tasks/T-100/detail`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json() as {
            task_id: string;
            detail_status: string;
            latest_cycle_events: unknown;
            audit: unknown;
            artifact_links: unknown[];
        };
        assert.equal(detail.task_id, 'T-100');
        assert.equal(detail.detail_status, 'loaded');
        assert.ok('latest_cycle_events' in detail);
        assert.ok('audit' in detail);
        assert.ok(Array.isArray(detail.artifact_links));
    } finally {
        await server.close();
    }
});

test('local UI server serves read-only dashboard controls', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const response = await fetch(server.url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /^text\/html\b/u);
        const html = await response.text();
        assert.match(html, /data-tab="tasks-tab"/u);
        assert.match(html, /Workflow Config/u);
        assert.match(html, /Instructions/u);
        assert.match(html, /Actions/u);
        assert.match(html, /Language/u);
        assert.match(html, /id="language-select"/u);
        assert.match(html, /id="task-search"/u);
        assert.match(html, /id="status-filter"/u);
        assert.match(html, /id="priority-filter"/u);
        assert.match(html, /id="actions"/u);
        assert.match(html, /id="settings-editor"/u);
        assert.match(html, /id="session-summary"/u);
        assert.match(html, /id="top-controls"/u);
        assert.match(html, /id="session-countdown"/u);
        assert.match(html, /api\/session/u);
        assert.match(html, /\.tab-buttons button \{[^}]*flex: 0 0 136px/u);
        assert.match(html, /\.session-compact \{[^}]*width: 410px/u);
        assert.match(html, /\.setting-buttons button, \.action-buttons button, \.switch-buttons button, #tasks button\[data-task-id\] \{[^}]*width: 138px/u);
        assert.match(html, /Gate Timeline/u);
        assert.match(html, /Artifacts/u);
    } finally {
        await server.close();
    }
});

test('local UI server applies initial language option to rendered dashboard', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'ru' });
    try {
        const html = await (await fetch(server.url)).text();
        assert.match(html, /<html lang="ru">/u);
        assert.match(html, /Загрузка сессии сервера/u);
        assert.equal(server.language, 'ru');
    } finally {
        await server.close();
    }
});

test('local UI dashboard client filters tabs and renders lazy details', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: {
                rows: [
                    {
                        task_id: 'T-100',
                        status: 'TODO',
                        status_token: 'TODO',
                        priority: 'P2',
                        area: 'ui/report',
                        title: 'Build UI',
                        owner: 'gpt-5.4',
                        notes: 'Uses lazy details',
                        detail: { detail_status: 'skipped' }
                    },
                    {
                        task_id: 'T-200',
                        status: 'DONE',
                        status_token: 'DONE',
                        priority: 'P1',
                        area: 'workflow',
                        title: 'Closed task',
                        owner: 'gpt-5.4',
                        notes: 'Archived',
                        detail: { detail_status: 'skipped' }
                    }
                ]
            },
            workflow_config_tab: {
                settings: [
                    {
                        key: 'full_suite_validation.enabled',
                        value: true,
                        command: 'garda workflow show',
                        description: 'Run full suite',
                        readonly: true
                    },
                    {
                        key: 'task_reset.enabled',
                        value: false,
                        command: 'garda workflow show',
                        description: 'Task reset disabled',
                        readonly: true
                    }
                ]
            },
            instructions_tab: {
                entries: [
                    {
                        title: 'Read-only',
                        body: 'No mutations'
                    }
                ]
            }
        };
        const detail = {
            task_id: 'T-100',
            stats: {
                events_count: 7,
                gate_pass_count: 5,
                gate_fail_count: 0,
                changed_lines_total: 42
            },
            latest_cycle_events: {
                status: 'PASS',
                gates: []
            },
            full_suite_validation: {
                state: 'passed',
                freshness: 'current',
                enabled: true,
                required: true,
                status: 'PASSED',
                command: 'npm test',
                placement: 'after_compile_before_reviews',
                duration_ms: 123456,
                duration_human: '2m 3.5s',
                timed_out: false,
                exit_code: 0,
                artifact_path: 'runtime/reviews/T-100-full-suite-validation.json',
                artifact_exists: true,
                artifact_sha256: 'abc123',
                output_artifact_path: 'runtime/reviews/T-100-full-suite-output.log',
                updated_at_utc: '2026-05-19T00:01:00.000Z',
                compact_summary: ['# tests 10', '# pass 10'],
                violations: [],
                warnings: [],
                skip_reason: null,
                mismatch_reason: null,
                timeout_forecast: {
                    history_path: 'runtime/full-suite-duration-history.json',
                    sample_count: 0,
                    average_duration_seconds: null,
                    high_watermark_duration_seconds: null,
                    recommended_timeout_seconds: 600,
                    safety_margin_seconds: null,
                    recommendation_source: 'config_timeout',
                    configured_timeout_seconds: 600,
                    warning: null
                },
                timeout_forecast_label: 'Recommended full-suite command timeout: 600s (configured timeout; no matching successful duration history yet).'
            },
            audit: {
                status: 'BLOCKED',
                blockers: [
                    {
                        gate: 'post-done-drift',
                        reason: 'blocked item'
                    }
                ],
                review_attempt_summary: {
                    by_type: [
                        {
                            review_type: 'code',
                            pass_count: 1,
                            fail_count: 0,
                            reused_count: 0
                        }
                    ]
                }
            },
            plan: {
                available: true,
                task_id: 'T-100',
                task_title: 'Build UI',
                task_status: 'TODO',
                summary: 'Implementation plan',
                plan_path: null,
                markdown_path: 'garda-agent-orchestrator/runtime/plans/T-100.md',
                markdown: '# T-100 plan\n\n- Build UI'
            },
            artifact_links: [
                {
                    kind: 'review',
                    path: 'runtime/reviews/T-100-code.md',
                    exists: true
                }
            ]
        };
        const actions = {
            enabled: true,
            actions: [
                {
                    id: 'status',
                    category: 'Inspection',
                    label: 'Status',
                    description: 'Run status',
                    command: 'node bin/garda.js status --target-root "."',
                    mutates: false,
                    requires_confirmation: false,
                    confirmation_phrase: null
                }
            ]
        };
        const settings = {
            enabled: true,
            settings: [
                {
                    id: 'full-suite-green-summary-max-lines',
                    key: 'full_suite_validation.green_summary_max_lines',
                    label: 'Full-suite green summary lines',
                    description: 'Tune green output',
                    current_value: 5,
                    value_type: 'integer',
                    options: [],
                    flag: '--full-suite-green-summary-max-lines',
                    min: 1,
                    max: 200,
                    confirmation_phrase: 'APPLY GARDA SETTING'
                }
            ]
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };

        const storedLanguageCalls: Array<[string, string]> = [];
        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
                    setItem: (key: string, value: string) => {
                        storedLanguageCalls.push([key, value]);
                    }
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session' || url === '/api/session/activity' || url === '/api/session/shutdown') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return actions;
                    }
                    if (url === '/api/settings') {
                        return settings;
                    }
                    if (url === '/api/tasks/T-100/actions') {
                        return {
                            action_id: 'task-stats',
                            task_id: 'T-100',
                            status: 'previewed',
                            command: 'node bin/garda.js task T-100 stats --target-root "."',
                            audit_path: 'runtime/ui-actions/audit.jsonl'
                        };
                    }
                    return detail;
                }
            })
        });
        await flushPromises();

        const tasksNode = fakeDocument.elements.tasks;
        assert.match(tasksNode.innerHTML, /T-100/u);
        assert.match(tasksNode.innerHTML, /T-200/u);
        assert.match(tasksNode.innerHTML, /On demand/u);
        assert.match(tasksNode.innerHTML, /Compact/u);

        fakeDocument.elements['task-search'].value = 'Closed';
        await fakeDocument.elements['task-search'].dispatch('input');
        assert.doesNotMatch(tasksNode.innerHTML, /T-100/u);
        assert.match(tasksNode.innerHTML, /T-200/u);

        fakeDocument.elements['task-search'].value = '';
        fakeDocument.elements['status-filter'].value = 'TODO';
        await fakeDocument.elements['status-filter'].dispatch('change');
        assert.match(tasksNode.innerHTML, /T-100/u);
        assert.doesNotMatch(tasksNode.innerHTML, /T-200/u);

        fakeDocument.elements['status-filter'].value = '';
        fakeDocument.elements['priority-filter'].value = 'P1';
        await fakeDocument.elements['priority-filter'].dispatch('change');
        assert.doesNotMatch(tasksNode.innerHTML, /T-100/u);
        assert.match(tasksNode.innerHTML, /T-200/u);

        fakeDocument.elements['priority-filter'].value = 'P2';
        await fakeDocument.elements['priority-filter'].dispatch('change');
        assert.match(tasksNode.innerHTML, /T-100/u);
        assert.doesNotMatch(tasksNode.innerHTML, /T-200/u);

        const workflowButton = fakeDocument.querySelectorAll('nav button[data-tab]')[1];
        await workflowButton.dispatch('click');
        assert.equal(fakeDocument.elements['tasks-tab'].hidden, true);
        assert.equal(fakeDocument.elements['workflow-tab'].hidden, false);
        assert.equal(fakeDocument.elements['task-detail-panel'].hidden, false);
        assert.match(fakeDocument.elements['settings-editor'].innerHTML, /full-suite-green-summary-max-lines/u);
        assert.match(fakeDocument.elements['settings-editor'].innerHTML, /full_suite_validation\.green_summary_max_lines/u);
        assert.match(fakeDocument.elements.instructions.innerHTML, /Read-only/u);
        assert.match(fakeDocument.elements.actions.innerHTML, /node bin\/garda\.js status/u);
        assert.match(fakeDocument.elements['garda-switch-panel'].innerHTML, /Switch action is hidden/u);
        assert.doesNotMatch(fakeDocument.elements['garda-switch-panel'].innerHTML, /data-action-id="garda-on"/u);
        assert.doesNotMatch(fakeDocument.elements['garda-switch-panel'].innerHTML, /data-action-id="garda-off"/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Shutdown in/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /15m/u);
        assert.doesNotMatch(fakeDocument.elements['session-summary'].innerHTML, /16m/u);
        assert.match(fakeDocument.elements['language-select'].innerHTML, /Русский/u);
        assert.match(fakeDocument.elements['ui-notice'].textContent, /127\.0\.0\.1/u);

        const taskButton = tasksNode.querySelectorAll('button[data-task-id]')[0];
        await taskButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements.detail.innerHTML, /Gate Timeline/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Runtime diagnostics/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Full-suite validation/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /2m 3\.5s/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /runtime\/reviews\/T-100-full-suite-validation\.json/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /post-done-drift: blocked item/u);
        assert.doesNotMatch(fakeDocument.elements.detail.innerHTML, /Audit status/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /blocked item/u);
        assert.doesNotMatch(fakeDocument.elements.detail.innerHTML, /\[object Object\]/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /runtime\/reviews\/T-100-code\.md/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /data-task-action-id="task-next-step"/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /data-task-action-id="task-reset-reopen"/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Task reset is disabled/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /data-task-action-id="task-stats"/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Show plan/u);
        const taskActionButton = fakeDocument.elements.detail.querySelectorAll('button[data-task-action-id]')
            .find((button) => button.dataset.taskActionId === 'task-stats' && button.dataset.taskActionMode === 'execute');
        assert.ok(taskActionButton);
        await taskActionButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements['task-action-status'].innerHTML, /node bin\/garda\.js task T-100 stats/u);

        fakeDocument.elements['language-select'].value = 'ru';
        await fakeDocument.elements['language-select'].dispatch('change');
        assert.deepEqual(storedLanguageCalls.at(-1), ['garda.ui.language', 'ru']);
        assert.match(fakeDocument.elements.detail.innerHTML, /События/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Статус full-suite/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Выключение через/u);
    } finally {
        await server.close();
    }
});

test('local UI dashboard restores persisted browser language on page load', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: {
                rows: [
                    {
                        task_id: 'T-100',
                        status: 'TODO',
                        status_token: 'TODO',
                        priority: 'P2',
                        area: 'ui/report',
                        title: 'Build UI',
                        owner: 'gpt-5.4',
                        notes: 'Uses lazy details',
                        detail: { detail_status: 'skipped' }
                    }
                ]
            },
            workflow_config_tab: { settings: [] },
            instructions_tab: { entries: [] }
        };
        const session = {
            enabled: true,
            state: 'active',
            last_activity_at: '2026-05-19T00:00:00.000Z',
            idle_minutes: 15,
            warning_seconds: 60,
            idle_deadline_at: '2026-05-19T00:15:00.000Z',
            shutdown_deadline_at: null,
            seconds_until_warning: 900,
            seconds_until_shutdown: null,
            stop_message: 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.'
        };

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: (key: string) => key === 'garda.ui.language' ? 'ru' : null,
                    setItem: () => undefined
                }
            },
            setInterval: () => 1,
            clearInterval: () => undefined,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/session') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return { enabled: false, switch_state: 'on', actions: [] };
                    }
                    if (url === '/api/settings') {
                        return { enabled: false, settings: [] };
                    }
                    return {};
                }
            })
        });
        await flushPromises();

        assert.equal(fakeDocument.elements['language-select'].value, 'ru');
        assert.match(fakeDocument.elements.overview.innerHTML, /Активные/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Выключение через/u);
    } finally {
        await server.close();
    }
});

test('local UI server rejects invalid or unknown task detail requests', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        assert.equal((await fetch(`${server.url}api/tasks/..%2Fsecret/detail`)).status, 400);
        assert.equal((await fetch(`${server.url}api/tasks/%E0%A4%A/detail`)).status, 400);
        assert.equal((await fetch(`${server.url}api/tasks/T-999/detail`)).status, 404);
    } finally {
        await server.close();
    }
});

test('local UI server returns JSON errors for API method and route failures', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const methodResponse = await fetch(`${server.url}api/report`, { method: 'POST' });
        assert.equal(methodResponse.status, 405);
        assert.match(methodResponse.headers.get('content-type') || '', /^application\/json\b/u);
        assert.deepEqual(await methodResponse.json(), {
            error: 'Only GET is supported.',
            code: 'method_not_allowed'
        });

        const routeResponse = await fetch(`${server.url}api/unknown`);
        assert.equal(routeResponse.status, 404);
        assert.match(routeResponse.headers.get('content-type') || '', /^application\/json\b/u);
        assert.deepEqual(await routeResponse.json(), {
            error: 'Not found.',
            code: 'not_found'
        });
    } finally {
        await server.close();
    }
});

test('local UI server exposes server-owned idle session state and activity reset', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
        const server = await startLocalUiServer({
            repoRoot,
            port: 0,
            idleMinutes: 0.01,
            idleWarningSeconds: 30
        });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const headers = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const initialResponse = await fetch(`${server.url}api/session`);
        assert.equal(initialResponse.status, 200);
        const initial = await initialResponse.json() as {
            enabled: boolean;
            state: string;
            idle_minutes: number;
            warning_seconds: number;
            seconds_until_warning: number | null;
        };
        assert.equal(initial.enabled, true);
        assert.equal(initial.state, 'active');
        assert.equal(initial.idle_minutes, 0.01);
        assert.equal(initial.warning_seconds, 30);
        assert.ok((initial.seconds_until_warning || 0) <= 1);

        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        const warning = await (await fetch(`${server.url}api/session`)).json() as {
            state: string;
            seconds_until_shutdown: number | null;
        };
        assert.equal(warning.state, 'warning');
        assert.ok((warning.seconds_until_shutdown || 0) <= 30);

        const activityResponse = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers,
            body: JSON.stringify({})
        });
        assert.equal(activityResponse.status, 200);
        const activity = await activityResponse.json() as {
            state: string;
            seconds_until_shutdown: number | null;
        };
        assert.equal(activity.state, 'active');
        assert.equal(activity.seconds_until_shutdown, null);
    } finally {
        await server.close().catch(() => undefined);
    }
});

test('local UI session posts require the page token and localhost boundary', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const missingToken = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body: JSON.stringify({})
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'session_boundary_rejected');

        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const crossOrigin = await fetch(`${server.url}api/session/activity`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body: JSON.stringify({})
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'session_boundary_rejected');
    } finally {
        await server.close();
    }
});

test('local UI manual session shutdown closes the foreground server', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    const actionToken = extractActionToken(await (await fetch(server.url)).text());
    const closePromise = new Promise<void>((resolve) => server.server.once('close', resolve));
    const response = await fetch(`${server.url}api/session/shutdown`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        },
        body: JSON.stringify({})
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { state: string; stop_message: string };
    assert.equal(payload.state, 'stopping');
    assert.match(payload.stop_message, /Rerun `garda ui`/u);
    await closePromise;
});

test('local UI idle expiry closes the server without browser heartbeat', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        idleMinutes: 0.001,
        idleWarningSeconds: 0.001
    });
    const closePromise = new Promise<void>((resolve) => server.server.once('close', resolve));
    await Promise.race([
        closePromise,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('server did not close after idle expiry')), 1500))
    ]);
});

test('local UI actions are disabled unless explicitly enabled', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        assert.deepEqual(await listResponse.json(), {
            enabled: false,
            switch_state: 'unknown',
            actions: []
        });

        const runResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action_id: 'status', mode: 'preview' })
        });
        assert.equal(runResponse.status, 403);
        assert.equal((await runResponse.json() as { code: string }).code, 'actions_disabled');

        const settingsResponse = await fetch(`${server.url}api/settings`);
        assert.equal(settingsResponse.status, 200);
        const settings = await settingsResponse.json() as { enabled: boolean; settings: Array<{ id: string }> };
        assert.equal(settings.enabled, false);
        assert.ok(settings.settings.some((setting) => setting.id === 'full-suite-green-summary-max-lines'));

        const settingRunResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 7 })
        });
        assert.equal(settingRunResponse.status, 403);
        assert.equal((await settingRunResponse.json() as { code: string }).code, 'settings_disabled');

        const taskRunResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action_id: 'task-stats', mode: 'preview' })
        });
        assert.equal(taskRunResponse.status, 403);
        assert.equal((await taskRunResponse.json() as { code: string }).code, 'actions_disabled');
    } finally {
        await server.close();
    }
});

test('local UI settings use guarded workflow commands with preview confirmation and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'updated',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const listResponse = await fetch(`${server.url}api/settings`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
            enabled: boolean;
            settings: Array<{
                id: string;
                key: string;
                current_value: unknown;
                value_type: string;
                options: Array<{ value: string }>;
            }>;
        };
        assert.equal(list.enabled, true);
        assert.ok(list.settings.some((setting) => setting.id === 'compile-gate-command'));
        assert.ok(list.settings.some((setting) => setting.id === 'full-suite-green-summary-max-lines'));
        assert.ok(list.settings.some((setting) => setting.key === 'full_suite_validation.enabled'));
        const scopeProfiles = list.settings.find((setting) => setting.id === 'scope-budget-profiles');
        assert.ok(scopeProfiles);
        assert.equal(scopeProfiles.value_type, 'enum_list');
        assert.ok(scopeProfiles.options.some((option) => option.value === 'strict'));

        const compilePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'compile-gate-command', mode: 'preview', value: 'npm run build' })
        });
        assert.equal(compilePreviewResponse.status, 200);
        const compilePreview = await compilePreviewResponse.json() as {
            key: string;
            proposed_value: string;
            command: string;
            changed_keys: string[];
        };
        assert.equal(compilePreview.key, 'compile_gate.command');
        assert.equal(compilePreview.proposed_value, 'npm run build');
        assert.deepEqual(compilePreview.changed_keys, ['compile_gate.command']);
        assert.match(compilePreview.command, /workflow set --compile-gate-command "npm run build"/u);

        const enumListPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-profiles', mode: 'preview', value: ['strict', 'balanced'] })
        });
        assert.equal(enumListPreviewResponse.status, 200);
        const enumListPreview = await enumListPreviewResponse.json() as {
            proposed_value: string[];
            command: string;
            changed_keys: string[];
        };
        assert.deepEqual(enumListPreview.proposed_value, ['strict', 'balanced']);
        assert.deepEqual(enumListPreview.changed_keys, ['scope_budget_guard.profiles']);
        assert.match(enumListPreview.command, /workflow set --scope-budget-profiles strict,balanced/u);

        const invalidEnumListResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'scope-budget-profiles', mode: 'preview', value: ['strict', 'made-up'] })
        });
        assert.equal(invalidEnumListResponse.status, 400);
        assert.equal((await invalidEnumListResponse.json() as { code: string }).code, 'invalid_setting_value');

        const invalidResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 0 })
        });
        assert.equal(invalidResponse.status, 400);
        assert.equal((await invalidResponse.json() as { code: string }).code, 'invalid_setting_value');

        const previewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'preview', value: 7 })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.equal(preview.key, 'full_suite_validation.green_summary_max_lines');
        assert.equal(preview.proposed_value, 7);
        assert.deepEqual(preview.changed_keys, ['full_suite_validation.green_summary_max_lines']);
        assert.match(preview.command, /workflow set --full-suite-green-summary-max-lines 7/u);
        assert.match(preview.command, /--operator-confirmed yes --operator-confirmed-at-utc/u);
        assert.doesNotMatch(preview.command, /workflow-config\.json/u);
        assert.equal(preview.confirmation_phrase, 'APPLY GARDA SETTING');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'execute', value: 7, confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'full-suite-green-summary-max-lines', mode: 'execute', value: 7, confirmation: 'APPLY GARDA SETTING' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'updated');
        assert.equal(executedCommands.length, 1);
        assert.match(executedCommands[0], /workflow set --full-suite-green-summary-max-lines 7/u);
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.ok(auditLines.length >= 3);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"setting:full-suite-green-summary-max-lines"/u);
        assert.match(auditLines[auditLines.length - 1], /"status":"executed"/u);
    } finally {
        await server.close();
    }
});

test('local UI actions support preview confirmation execution and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as { enabled: boolean; actions: Array<{ id: string; category: string; command: string }> };
        assert.equal(list.enabled, true);
        assert.ok(list.actions.some((action) => action.id === 'html-report'));
        assert.ok(list.actions.some((action) => action.id === 'garda-on' && action.category === 'Garda switch'));
        assert.ok(list.actions.some((action) => action.id === 'garda-off' && action.category === 'Garda switch'));
        assert.ok(list.actions.some((action) => action.id === 'cleanup-preview' && action.category === 'Maintenance'));
        assert.ok(list.actions.some((action) => action.id === 'cleanup-apply' && action.category === 'Maintenance'));
        assert.ok(list.actions.every((action) => action.command.includes('bin/garda.js')));

        const previewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'html-report', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.match(preview.command, /html --target-root/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'RUN GARDA HTML');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'html-report', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'html-report', mode: 'execute', confirmation: 'RUN GARDA HTML' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'ok');
        assert.equal(executedCommands.length, 1);
        assert.ok(fs.existsSync(execute.audit_path));
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.equal(auditLines.length, 3);
        assert.match(auditLines[0], /"status":"previewed"/u);
        assert.match(auditLines[1], /"status":"confirmation_required"/u);
        assert.match(auditLines[2], /"status":"executed"/u);
    } finally {
        await server.close();
    }
});

test('local UI task actions support preview confirmation execution and audit', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const executedCommands: string[] = [];
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => {
            executedCommands.push(action.command.display);
            return {
                exit_code: 0,
                signal: null,
                stdout: 'task ok',
                stderr: ''
            };
        }
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const actionHeaders = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };

        const previewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-next-step', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            task_id: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.equal(preview.task_id, 'T-100');
        assert.match(preview.command, /next-step T-100 --repo-root/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'RUN TASK NEXT STEP');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-next-step', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const disabledResetResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'preview' })
        });
        assert.equal(disabledResetResponse.status, 409);
        const disabledReset = await disabledResetResponse.json() as {
            status: string;
            unavailable_reason: string;
            command: string;
        };
        assert.equal(disabledReset.status, 'unavailable');
        assert.match(disabledReset.unavailable_reason, /task_reset\.enabled/u);
        assert.match(disabledReset.command, /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.deepEqual(executedCommands, []);

        setTaskResetEnabled(repoRoot, true);
        const resetPreviewResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'preview' })
        });
        assert.equal(resetPreviewResponse.status, 200);
        const resetPreview = await resetPreviewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(resetPreview.status, 'previewed');
        assert.match(resetPreview.command, /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);
        assert.equal(resetPreview.requires_confirmation, true);
        assert.equal(resetPreview.confirmation_phrase, 'RESET TASK');

        const resetBlockedResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(resetBlockedResponse.status, 409);
        assert.equal((await resetBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const resetExecuteResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-reset-reopen', mode: 'execute', confirmation: 'RESET TASK' })
        });
        assert.equal(resetExecuteResponse.status, 200);
        const resetExecute = await resetExecuteResponse.json() as { status: string; stdout: string };
        assert.equal(resetExecute.status, 'executed');
        assert.equal(resetExecute.stdout, 'task ok');
        assert.equal(executedCommands.length, 1);
        assert.match(executedCommands[0], /gate task-reset --task-id T-100 --reopen --confirm --repo-root/u);

        const statsResponse = await fetch(`${server.url}api/tasks/T-100/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-stats', mode: 'execute' })
        });
        assert.equal(statsResponse.status, 200);
        const stats = await statsResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(stats.status, 'executed');
        assert.equal(stats.stdout, 'task ok');
        assert.equal(executedCommands.length, 2);
        assert.match(executedCommands[1], /task T-100 stats --target-root/u);
        const auditLines = fs.readFileSync(stats.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"T-100:task-stats"/u);
        assert.match(auditLines[auditLines.length - 1], /"status":"executed"/u);

        const unknownTaskResponse = await fetch(`${server.url}api/tasks/T-999/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'task-stats', mode: 'preview' })
        });
        assert.equal(unknownTaskResponse.status, 404);
    } finally {
        await server.close();
    }
});

test('local UI actions reject cross-origin missing-token and non-json posts', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async () => ({
            exit_code: 0,
            signal: null,
            stdout: 'unexpected',
            stderr: ''
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const body = JSON.stringify({ action_id: 'status', mode: 'execute' });
        const missingToken = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'action_boundary_rejected');

        const crossOrigin = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'action_boundary_rejected');

        const nonJson = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'text/plain',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(nonJson.status, 403);
        assert.equal((await nonJson.json() as { code: string }).code, 'action_boundary_rejected');
    } finally {
        await server.close();
    }
});

test('local UI settings reject cross-origin missing-token and non-json posts', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async () => ({
            exit_code: 0,
            signal: null,
            stdout: 'unexpected',
            stderr: ''
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const body = JSON.stringify({
            setting_id: 'full-suite-green-summary-max-lines',
            mode: 'preview',
            value: 7
        });
        const missingToken = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1)
            },
            body
        });
        assert.equal(missingToken.status, 403);
        assert.equal((await missingToken.json() as { code: string }).code, 'action_boundary_rejected');

        const crossOrigin = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://example.test',
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await crossOrigin.json() as { code: string }).code, 'action_boundary_rejected');

        const nonJson = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: {
                'content-type': 'text/plain',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body
        });
        assert.equal(nonJson.status, 403);
        assert.equal((await nonJson.json() as { code: string }).code, 'action_boundary_rejected');
    } finally {
        await server.close();
    }
});

test('local UI server refreshes cached task snapshot after TASK.md changes', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        assert.equal((await fetch(`${server.url}api/tasks/T-100/detail`)).status, 200);
        writeTaskQueue(repoRoot, 'T-101', 'Updated UI');
        const taskPath = path.join(repoRoot, 'TASK.md');
        const future = new Date(Date.now() + 2000);
        fs.utimesSync(taskPath, future, future);

        assert.equal((await fetch(`${server.url}api/tasks/T-100/detail`)).status, 404);
        assert.equal((await fetch(`${server.url}api/tasks/T-101/detail`)).status, 200);
    } finally {
        await server.close();
    }
});

test('local UI server skips busy ports in the default local range', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const reserved = await reservePort();
    const address = reserved.address();
    assert.equal(typeof address, 'object');
    const busyPort = (address as net.AddressInfo).port;
    const server = await startLocalUiServer({
        repoRoot,
        portStart: busyPort,
        portEnd: busyPort + 1
    });
    try {
        assert.equal(server.host, DEFAULT_UI_HOST);
        assert.equal(server.port, busyPort + 1);
    } finally {
        await server.close();
        await closeNetServer(reserved);
    }
});

test('local UI server skips browser-unsafe ports in configured local ranges', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        portStart: 6000,
        portEnd: 6001
    });
    try {
        assert.equal(server.host, DEFAULT_UI_HOST);
        assert.equal(server.port, 6001);
        const response = await fetch(server.url);
        assert.equal(response.status, 200);
    } finally {
        await server.close();
    }
});

test('local UI server falls back to a safe range when port 0 repeatedly binds unsafe ports', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const { reserved, busyPort, nextPort } = await reserveConsecutivePortPair();
    const originalAddress = http.Server.prototype.address;
    let unsafeDynamicBinds = 0;
    http.Server.prototype.address = function patchedAddress(this: http.Server) {
        const address = originalAddress.call(this);
        if (unsafeDynamicBinds < 25 && address && typeof address === 'object') {
            unsafeDynamicBinds += 1;
            return {
                ...address,
                port: 6000
            };
        }
        return address;
    };
    try {
        const server = await startLocalUiServer({
            repoRoot,
            port: 0,
            portStart: busyPort,
            portEnd: nextPort
        });
        try {
            assert.equal(server.host, DEFAULT_UI_HOST);
            assert.equal(server.port, nextPort);
            const response = await fetch(server.url);
            assert.equal(response.status, 200);
        } finally {
            await server.close();
        }
        assert.equal(unsafeDynamicBinds, 25);
    } finally {
        http.Server.prototype.address = originalAddress;
        await closeNetServer(reserved);
    }
});

test('local UI server rejects browser-unsafe explicit ports', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    await assert.rejects(
        () => startLocalUiServer({ repoRoot, port: 6000 }),
        /not browser-safe/
    );
});

test('local UI server refuses non-localhost binding', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    await assert.rejects(
        () => startLocalUiServer({ repoRoot, host: '0.0.0.0', port: 0 }),
        /only supports binding to 127\.0\.0\.1/
    );
});
