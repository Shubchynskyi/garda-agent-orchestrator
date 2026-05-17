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
        if (selector !== 'button[data-task-id]') {
            return [];
        }
        if (this.buttonCacheHtml !== this.innerHTML) {
            this.buttonCacheHtml = this.innerHTML;
            this.buttonCache = Array.from(this.innerHTML.matchAll(/data-task-id="([^"]+)"/gu), (match) => {
                const button = new FakeElement(`button-${match[1]}`);
                button.dataset.taskId = match[1];
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
        'instructions',
        'task-search',
        'status-filter',
        'priority-filter',
        'tasks-tab',
        'workflow-tab',
        'instructions-tab',
        'task-detail-panel'
    ]) {
        elements[id] = new FakeElement(id, id.endsWith('-tab') || id === 'task-detail-panel' ? ['tab'] : []);
    }
    elements['workflow-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'instructions-tab'].map((tabId, index) => {
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
        assert.match(html, /id="task-search"/u);
        assert.match(html, /id="status-filter"/u);
        assert.match(html, /id="priority-filter"/u);
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

        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            fetch: async (url: string) => ({
                ok: true,
                status: 200,
                json: async () => url === '/api/report' ? report : detail
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
        assert.match(fakeDocument.elements.instructions.innerHTML, /Read-only/u);

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
