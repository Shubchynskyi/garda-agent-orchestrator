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
        for (const listener of this.listeners.get(eventName) || []) {
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
        'backups-tab',
        'backups-settings',
        'backups-table',
        'backup-action-status',
        'cleanup-settings-tab',
        'cleanup-settings',
        'cleanup-status',
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
    elements['cleanup-settings-tab'].hidden = true;
    elements['instructions-tab'].hidden = true;
    elements['actions-tab'].hidden = true;

    const navButtons = ['tasks-tab', 'workflow-tab', 'init-settings-tab', 'project-memory-tab', 'backups-tab', 'cleanup-settings-tab', 'instructions-tab', 'actions-tab'].map((tabId, index) => {
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
                    elements['cleanup-settings-tab'],
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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI dashboard prefers case-insensitive regional browser language before base fallback', async () => {
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
            navigator: {
                language: 'pt-br',
                languages: ['pt-br', 'pt']
            },
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
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

        assert.equal(fakeDocument.elements['language-select'].value, 'pt-BR');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI dashboard falls back from unsupported browser locale to server initial language', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'de' });
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
            navigator: {
                language: 'zz-ZZ',
                languages: ['zz-ZZ']
            },
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
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

        assert.equal(fakeDocument.elements['language-select'].value, 'de');
        assert.match(fakeDocument.elements.overview.innerHTML, /Aktiv/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI cleanup settings rerender when the dashboard language changes', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0, language: 'en' });
    try {
        const html = await (await fetch(server.url)).text();
        const fakeDocument = createFakeDocument();
        const report = {
            repo_root: repoRoot,
            unavailable: [],
            tasks_tab: { rows: [] },
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
        const cleanupPayload = {
            enabled: false,
            config_path: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'runtime-retention.json'),
            settings: {
                daily_maintenance_enabled: true,
                daily_maintenance_max_tasks_per_run: 5,
                daily_maintenance_dry_run: true,
                eligible_older_than_days: 14,
                keep_latest_tasks: 10,
                purge_require_confirm: true,
                healthy_done_compact_after_days: 7,
                problem_tasks_compress_after_days: 30
            }
        };
        const context: Record<string, unknown> = {
            document: fakeDocument,
            window: {
                prompt: () => null,
                addEventListener: () => undefined,
                localStorage: {
                    getItem: () => null,
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
                    if (url === '/api/cleanup-settings') {
                        return cleanupPayload;
                    }
                    return {};
                }
            })
        };

        vm.runInNewContext(extractDashboardScript(html), context);
        await flushPromises();
        assert.match(fakeDocument.elements['cleanup-settings'].innerHTML, /Effective policy/u);

        const renderCleanupResult = context.renderCleanupResult as ((result: unknown) => void) | undefined;
        assert.equal(typeof renderCleanupResult, 'function');
        assert.ok(renderCleanupResult);
        renderCleanupResult({
            status: 'previewed',
            action_id: 'cleanup-run',
            command: 'garda cleanup --dry-run'
        });
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Preview only/u);

        fakeDocument.elements['language-select'].value = 'de';
        await fakeDocument.elements['language-select'].dispatch('change');

        assert.match(fakeDocument.elements['cleanup-settings'].innerHTML, /Wirksame Richtlinie/u);
        assert.match(fakeDocument.elements['cleanup-status'].innerHTML, /Nur Vorschau/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
