import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
        if (selector !== 'button[data-task-id]' && selector !== 'button[data-action-id]' && selector !== 'button[data-setting-id]') {
            return [];
        }
        if (this.buttonCacheHtml !== this.innerHTML) {
            this.buttonCacheHtml = this.innerHTML;
            const attributeName = selector === 'button[data-task-id]'
                ? 'task-id'
                : selector === 'button[data-action-id]'
                    ? 'action-id'
                    : 'setting-id';
            const dataKey = selector === 'button[data-task-id]'
                ? 'taskId'
                : selector === 'button[data-action-id]'
                    ? 'actionId'
                    : 'settingId';
            const modePattern = /data-action-mode="([^"]+)"/u;
            const settingModePattern = /data-setting-mode="([^"]+)"/u;
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
        'workflow',
        'settings-editor',
        'instructions',
        'actions',
        'action-status',
        'task-search',
        'status-filter',
        'priority-filter',
        'tasks-tab',
        'workflow-tab',
        'instructions-tab',
        'actions-tab',
        'task-detail-panel'
    ]) {
        elements[id] = new FakeElement(id, id.endsWith('-tab') || id === 'task-detail-panel' ? ['tab'] : []);
    }
    elements['workflow-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'instructions-tab', 'actions-tab'].map((tabId, index) => {
        const button = new FakeElement(`nav-${tabId}`, index === 0 ? ['active'] : []);
        button.dataset.tab = tabId;
        return button;
    });

    return {
        elements,
        getElementById: (id: string) => elements[id],
        querySelectorAll: (selector: string) => {
            if (selector === 'nav button[data-tab]') {
                return navButtons;
            }
            if (selector === '.tab') {
                return [
                    elements['tasks-tab'],
                    elements['workflow-tab'],
                    elements['instructions-tab'],
                    elements['actions-tab'],
                    elements['task-detail-panel']
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
        assert.match(html, /id="task-search"/u);
        assert.match(html, /id="status-filter"/u);
        assert.match(html, /id="priority-filter"/u);
        assert.match(html, /id="actions"/u);
        assert.match(html, /id="settings-editor"/u);
        assert.match(html, /Gate Timeline/u);
        assert.match(html, /Artifacts/u);
    } finally {
        await server.close();
    }
});

test('local UI dashboard client filters tabs and renders lazy details', async () => {
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
                        notes: 'Uses lazy details'
                    },
                    {
                        task_id: 'T-200',
                        status: 'DONE',
                        status_token: 'DONE',
                        priority: 'P1',
                        area: 'workflow',
                        title: 'Closed task',
                        owner: 'gpt-5.4',
                        notes: 'Archived'
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
            audit: {
                blockers: ['blocked item'],
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
                    label: 'Status',
                    description: 'Run status',
                    command: 'node bin/garda.js status --target-root "."',
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
                    min: 1,
                    max: 200,
                    confirmation_phrase: 'APPLY GARDA SETTING'
                }
            ]
        };

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            window: {
                prompt: () => null
            },
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => {
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        return actions;
                    }
                    if (url === '/api/settings') {
                        return settings;
                    }
                    return detail;
                }
            })
        });
        await flushPromises();

        const tasksNode = fakeDocument.elements.tasks;
        assert.match(tasksNode.innerHTML, /T-100/u);
        assert.match(tasksNode.innerHTML, /T-200/u);

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
        assert.match(fakeDocument.elements.workflow.innerHTML, /full_suite_validation\.enabled/u);
        assert.match(fakeDocument.elements['settings-editor'].innerHTML, /full-suite-green-summary-max-lines/u);
        assert.match(fakeDocument.elements.instructions.innerHTML, /Read-only/u);
        assert.match(fakeDocument.elements.actions.innerHTML, /node bin\/garda\.js status/u);

        const taskButton = tasksNode.querySelectorAll('button[data-task-id]')[0];
        await taskButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements.detail.innerHTML, /Gate Timeline/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /blocked item/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /runtime\/reviews\/T-100-code\.md/u);
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

test('local UI actions are disabled unless explicitly enabled', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const listResponse = await fetch(`${server.url}api/actions`);
        assert.equal(listResponse.status, 200);
        assert.deepEqual(await listResponse.json(), {
            enabled: false,
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
            settings: Array<{ id: string; key: string; current_value: unknown }>;
        };
        assert.equal(list.enabled, true);
        assert.ok(list.settings.some((setting) => setting.id === 'full-suite-green-summary-max-lines'));
        assert.ok(!list.settings.some((setting) => setting.key === 'full_suite_validation.enabled'));

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
        const list = await listResponse.json() as { enabled: boolean; actions: Array<{ id: string; command: string }> };
        assert.equal(list.enabled, true);
        assert.ok(list.actions.some((action) => action.id === 'html-report'));
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

test('local UI server refuses non-localhost binding', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    await assert.rejects(
        () => startLocalUiServer({ repoRoot, host: '0.0.0.0', port: 0 }),
        /only supports binding to 127\.0\.0\.1/
    );
});
