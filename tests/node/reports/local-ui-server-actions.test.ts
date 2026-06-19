import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as net from 'node:net';
import * as vm from 'node:vm';
import {
    DEFAULT_UI_HOST,
    startLocalUiServer
} from '../../../src/reports/ui';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    setLocalUiTaskResetEnabled,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

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
        for (const listener of [...(this.listeners.get(eventName) || [])]) {
            await listener();
        }
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== 'button[data-task-id]'
            && selector !== 'button[data-action-id]'
            && selector !== 'button[data-setting-id]'
            && selector !== 'button[data-task-action-id]'
            && selector !== 'button[data-backup-action-id]'
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
                        : selector === 'button[data-backup-action-id]'
                            ? 'backup-action-id'
                            : 'instruction-tab';
            const dataKey = selector === 'button[data-task-id]'
                ? 'taskId'
                : selector === 'button[data-action-id]'
                    ? 'actionId'
                    : selector === 'button[data-setting-id]'
                        ? 'settingId'
                        : selector === 'button[data-task-action-id]'
                            ? 'taskActionId'
                            : selector === 'button[data-backup-action-id]'
                                ? 'backupActionId'
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
        'backups-tab',
        'backups-settings',
        'backups-table',
        'backup-action-status',
        'instructions-tab',
        'actions-tab',
        'task-detail-panel'
    ]) {
        elements[id] = new FakeElement(id, id.endsWith('-tab') ? ['tab'] : []);
    }
    elements['workflow-tab'].hidden = true;
    elements['init-settings-tab'].hidden = true;
    elements['project-memory-tab'].hidden = true;
    elements['backups-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;
    elements['actions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'init-settings-tab', 'project-memory-tab', 'backups-tab', 'instructions-tab', 'actions-tab'].map((tabId, index) => {
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
                    elements['backups-tab'],
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

const makeTempRepo = makeLocalUiTempRepo;
const writeRepo = writeLocalUiRepoFixture;
const setTaskResetEnabled = setLocalUiTaskResetEnabled;

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

function postJsonWithHostHeader(options: {
    port: number;
    path: string;
    hostHeader: string;
    origin: string;
    actionToken: string;
    body: unknown;
}): Promise<{ statusCode: number; payload: { code?: string } }> {
    const body = JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: DEFAULT_UI_HOST,
            port: options.port,
            path: options.path,
            method: 'POST',
            headers: {
                host: options.hostHeader,
                origin: options.origin,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'x-garda-action-token': options.actionToken
            }
        }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
            });
            response.on('end', () => {
                resolve({
                    statusCode: response.statusCode || 0,
                    payload: raw ? JSON.parse(raw) as { code?: string } : {}
                });
            });
        });
        request.on('error', reject);
        request.end(body);
    });
}

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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
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

        const spoofedHost = await postJsonWithHostHeader({
            port: server.port,
            path: '/api/session/activity',
            hostHeader: `evil.test:${server.port}`,
            origin: `http://evil.test:${server.port}`,
            actionToken,
            body: {}
        });
        assert.equal(spoofedHost.statusCode, 403);
        assert.equal(spoofedHost.payload.code, 'session_boundary_rejected');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI manual session shutdown closes the foreground server', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
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
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
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
    try {
        const closePromise = new Promise<void>((resolve) => server.server.once('close', resolve));
        await Promise.race([
            closePromise,
            new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('server did not close after idle expiry')), 1500))
        ]);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
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
            switch_state: 'unknown',
            actions: []
        });

        const runResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action_id: 'garda-off', mode: 'preview' })
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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI switch actions support preview confirmation execution and audit', async () => {
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
        const list = await listResponse.json() as { enabled: boolean; actions: Array<{ id: string; category: string; command: string; timeout_ms: number }> };
        assert.equal(list.enabled, true);
        assert.ok(list.actions.some((action) => action.id === 'garda-on' && action.category === 'Garda switch'));
        assert.ok(list.actions.some((action) => action.id === 'garda-off' && action.category === 'Garda switch'));
        assert.ok(list.actions.every((action) => !['status', 'doctor', 'html-report', 'cleanup-preview', 'cleanup-apply'].includes(action.id)));
        assert.ok(list.actions.every((action) => action.command.includes('bin/garda.js')));
        assert.ok(list.actions.every((action) => Number.isInteger(action.timeout_ms) && action.timeout_ms > 0));

        const previewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.match(preview.command, /off --target-root/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'TURN GARDA OFF');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'TURN GARDA OFF' })
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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI manual backup action supports preview confirmation execution and audit', async () => {
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
                stdout: 'backup ok',
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
        const list = await listResponse.json() as {
            enabled: boolean;
            actions: Array<{
                id: string;
                category: string;
                command: string;
                requires_confirmation: boolean;
                confirmation_phrase: string;
            }>;
        };
        const action = list.actions.find((item) => item.id === 'backup-create-manual');
        assert.ok(action, 'manual backup action must be exposed');
        assert.equal(action.category, 'Backups');
        assert.match(action.command, /backup create --target-root \. --confirm/u);
        assert.equal(action.requires_confirmation, true);
        assert.equal(action.confirmation_phrase, 'CREATE BACKUP');

        const previewResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'preview' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as {
            status: string;
            command: string;
            requires_confirmation: boolean;
            confirmation_phrase: string;
        };
        assert.equal(preview.status, 'previewed');
        assert.match(preview.command, /backup create --target-root \. --confirm/u);
        assert.equal(preview.requires_confirmation, true);
        assert.equal(preview.confirmation_phrase, 'CREATE BACKUP');
        assert.deepEqual(executedCommands, []);

        const blockedResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'execute', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');
        assert.deepEqual(executedCommands, []);

        const executeResponse = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ action_id: 'backup-create-manual', mode: 'execute', confirmation: 'CREATE BACKUP' })
        });
        assert.equal(executeResponse.status, 200);
        const execute = await executeResponse.json() as { status: string; stdout: string; audit_path: string };
        assert.equal(execute.status, 'executed');
        assert.equal(execute.stdout, 'backup ok');
        assert.equal(executedCommands.length, 1);
        assert.match(executedCommands[0], /backup create --target-root \. --confirm/u);
        const auditLines = fs.readFileSync(execute.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.equal(auditLines.length, 3);
        assert.match(auditLines[0], /"status":"previewed"/u);
        assert.match(auditLines[1], /"status":"confirmation_required"/u);
        assert.match(auditLines[2], /"action_id":"backup-create-manual"/u);
        assert.match(auditLines[2], /"status":"executed"/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI visible action timeout result returns deterministic HTTP and audit fields', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0,
        actionsEnabled: true,
        actionRunner: async (action) => ({
            exit_code: 1,
            signal: null,
            stdout: '',
            stderr: 'Process timed out after action budget.',
            timed_out: true,
            timeout_ms: action.timeout_ms
        })
    });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const response = await fetch(`${server.url}api/actions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': server.url.slice(0, -1),
                'x-garda-action-token': actionToken
            },
            body: JSON.stringify({ action_id: 'garda-off', mode: 'execute', confirmation: 'TURN GARDA OFF' })
        });

        assert.equal(response.status, 504);
        const payload = await response.json() as {
            status: string;
            timed_out: boolean;
            timeout_ms: number;
            stderr: string;
            audit_path: string;
        };
        assert.equal(payload.status, 'executed');
        assert.equal(payload.timed_out, true);
        assert.equal(payload.timeout_ms, 60000);
        assert.match(payload.stderr, /timed out/u);

        const auditLines = fs.readFileSync(payload.audit_path, 'utf8').trim().split(/\r?\n/u);
        assert.match(auditLines[auditLines.length - 1], /"action_id":"garda-off"/u);
        assert.match(auditLines[auditLines.length - 1], /"timed_out":true/u);
        assert.match(auditLines[auditLines.length - 1], /"timeout_ms":60000/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI cleanup settings expose policy edits dynamic cleanup and task purge', async () => {
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
                stdout: 'cleanup ok',
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

        const policyResponse = await fetch(`${server.url}api/cleanup-settings`);
        assert.equal(policyResponse.status, 200);
        const policy = await policyResponse.json() as {
            enabled: boolean;
            confirmation_phrase: string;
            settings: {
                daily_maintenance_enabled: boolean;
                eligible_older_than_days: number;
                keep_latest_tasks: number;
            };
        };
        assert.equal(policy.enabled, true);
        assert.equal(policy.confirmation_phrase, 'SAVE CLEANUP SETTINGS');
        assert.equal(policy.settings.daily_maintenance_enabled, false);
        assert.equal(policy.settings.eligible_older_than_days, 30);
        assert.equal(policy.settings.keep_latest_tasks, 0);

        const settingsPayload = {
            daily_maintenance_enabled: true,
            daily_maintenance_max_tasks_per_run: '7',
            eligible_older_than_days: '45',
            keep_latest_tasks: '3',
            daily_maintenance_dry_run: false
        };
        const settingsPreviewResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'preview', settings: settingsPayload })
        });
        assert.equal(settingsPreviewResponse.status, 200);
        const settingsPreview = await settingsPreviewResponse.json() as {
            status: string;
            command: string;
            proposed_settings: { daily_maintenance: { eligible_older_than_days: number; keep_latest_tasks: number } };
        };
        assert.equal(settingsPreview.status, 'previewed');
        assert.match(settingsPreview.command, /runtime-retention\.json/u);
        assert.equal(settingsPreview.proposed_settings.daily_maintenance.eligible_older_than_days, 45);
        assert.equal(settingsPreview.proposed_settings.daily_maintenance.keep_latest_tasks, 3);

        const blockedSaveResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', settings: settingsPayload, confirmation: 'wrong' })
        });
        assert.equal(blockedSaveResponse.status, 409);
        assert.equal((await blockedSaveResponse.json() as { status: string }).status, 'confirmation_required');

        const saveResponse = await fetch(`${server.url}api/cleanup-settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', settings: settingsPayload, confirmation: 'SAVE CLEANUP SETTINGS' })
        });
        assert.equal(saveResponse.status, 200);
        const runtimeRetentionPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'runtime-retention.json');
        const savedPolicy = JSON.parse(fs.readFileSync(runtimeRetentionPath, 'utf8')) as {
            daily_maintenance: { enabled: boolean; max_tasks_per_run: number; eligible_older_than_days: number; keep_latest_tasks: number; dry_run: boolean };
        };
        assert.deepEqual(savedPolicy.daily_maintenance, {
            enabled: true,
            max_tasks_per_run: 7,
            eligible_older_than_days: 45,
            keep_latest_tasks: 3,
            dry_run: false
        });

        const runPreviewResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'preview', eligible_older_than_days: '11', keep_latest_tasks: '2' })
        });
        assert.equal(runPreviewResponse.status, 200);
        const runPreview = await runPreviewResponse.json() as { status: string; command: string };
        assert.equal(runPreview.status, 'previewed');
        assert.match(runPreview.command, /cleanup --target-root \. --dry-run/u);
        assert.match(runPreview.command, /--runtime-retention-older-than-days 11/u);
        assert.match(runPreview.command, /--runtime-retention-keep-latest-tasks 2/u);
        assert.deepEqual(executedCommands, []);

        const runBlockedResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                mode: 'execute',
                eligible_older_than_days: '11',
                keep_latest_tasks: '2',
                confirmation: 'wrong'
            })
        });
        assert.equal(runBlockedResponse.status, 409);
        const runBlocked = await runBlockedResponse.json() as {
            status: string;
            confirmation_phrase: string;
            command: string;
        };
        assert.equal(runBlocked.status, 'confirmation_required');
        assert.equal(runBlocked.confirmation_phrase, 'RUN GARDA CLEANUP');
        assert.match(runBlocked.command, /cleanup --target-root \. --confirm/u);
        assert.deepEqual(executedCommands, []);

        const runApplyResponse = await fetch(`${server.url}api/cleanup-run`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({
                mode: 'execute',
                eligible_older_than_days: '11',
                keep_latest_tasks: '2',
                confirmation: 'RUN GARDA CLEANUP'
            })
        });
        assert.equal(runApplyResponse.status, 200);
        const runApply = await runApplyResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(runApply.status, 'executed');
        assert.match(runApply.command, /cleanup --target-root \. --confirm/u);
        assert.match(runApply.command, /--runtime-retention-older-than-days 11/u);
        assert.match(runApply.command, /--runtime-retention-keep-latest-tasks 2/u);
        assert.equal(runApply.stdout, 'cleanup ok');
        assert.equal(executedCommands.length, 1);

        const taskPurgeBlockedResponse = await fetch(`${server.url}api/cleanup-task-purge`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', task_id: 'T-100', confirmation: 'wrong' })
        });
        assert.equal(taskPurgeBlockedResponse.status, 409);
        assert.equal((await taskPurgeBlockedResponse.json() as { status: string }).status, 'confirmation_required');

        const taskPurgeResponse = await fetch(`${server.url}api/cleanup-task-purge`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ mode: 'execute', task_id: 'T-100', confirmation: 'PURGE TASK RUNTIME' })
        });
        assert.equal(taskPurgeResponse.status, 200);
        const taskPurge = await taskPurgeResponse.json() as { status: string; command: string; stdout: string };
        assert.equal(taskPurge.status, 'executed');
        assert.match(taskPurge.command, /cleanup task-purge --target-root \. --task-id T-100 --confirm/u);
        assert.equal(taskPurge.stdout, 'cleanup ok');
        assert.equal(executedCommands.length, 2);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        const body = JSON.stringify({ action_id: 'garda-off', mode: 'execute' });
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

        const spoofedHost = await postJsonWithHostHeader({
            port: server.port,
            path: '/api/actions',
            hostHeader: `evil.test:${server.port}`,
            origin: `http://evil.test:${server.port}`,
            actionToken,
            body: { action_id: 'garda-off', mode: 'preview' }
        });
        assert.equal(spoofedHost.statusCode, 403);
        assert.equal(spoofedHost.payload.code, 'action_boundary_rejected');

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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
