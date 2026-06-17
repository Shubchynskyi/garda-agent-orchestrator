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
    removeLocalUiTempRepo,
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

function openHttpGetResponse(url: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            resolve(response);
        });
        request.once('error', reject);
    });
}

async function expectSettlesWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`${label} did not settle within ${timeoutMs}ms`));
        }, timeoutMs);
        timeoutHandle.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

test('local UI server skips busy ports in the default local range', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const { reserved, busyPort, nextPort } = await reserveConsecutivePortPair();
    const server = await startLocalUiServer({
        repoRoot,
        portStart: busyPort,
        portEnd: nextPort
    });
    try {
        assert.equal(server.host, DEFAULT_UI_HOST);
        assert.equal(server.port, nextPort);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server, netServers: [reserved] });
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
        await response.text();
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI server close drains unconsumed fetch response sockets', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({
        repoRoot,
        port: 0
    });
    const response = await openHttpGetResponse(server.url);
    try {
        assert.equal(response.statusCode, 200);
        await expectSettlesWithin(
            server.close(),
            1000,
            'local UI server close with an unconsumed HTTP response'
        );
    } finally {
        response.destroy();
        removeLocalUiTempRepo(repoRoot);
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
            await response.text();
        } finally {
            await cleanupLocalUiTestResources({ repoRoot, server });
        }
        assert.equal(unsafeDynamicBinds, 25);
    } finally {
        http.Server.prototype.address = originalAddress;
        await cleanupLocalUiTestResources({ repoRoot, netServers: [reserved] });
    }
});

test('local UI server rejects browser-unsafe explicit ports', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    try {
        await assert.rejects(
            () => startLocalUiServer({ repoRoot, port: 6000 }),
            /not browser-safe/
        );
    } finally {
        removeLocalUiTempRepo(repoRoot);
    }
});

test('local UI server refuses non-localhost binding', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    try {
        await assert.rejects(
            () => startLocalUiServer({ repoRoot, host: '0.0.0.0', port: 0 }),
            /only supports binding to 127\.0\.0\.1/
        );
    } finally {
        removeLocalUiTempRepo(repoRoot);
    }
});
