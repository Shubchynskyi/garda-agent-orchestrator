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
        assert.match(html, /data-tab="backups-tab"/u);
        assert.match(html, /id="backups-tab"/u);
        assert.match(html, /id="backups-table"/u);
        assert.match(html, /id="backups-settings"/u);
        assert.match(html, /Workflow Config/u);
        assert.match(html, /Backups/u);
        assert.match(html, /Instructions/u);
        assert.match(html, /data-tab="actions-tab"/u);
        assert.match(html, /class="language-icon"/u);
        assert.match(html, /id="language-select"[^>]*data-i18n-aria-label="languageTitle"/u);
        assert.match(html, /visually-hidden[^>]*data-i18n="languageTitle"/u);
        assert.match(html, /id="task-search"/u);
        assert.match(html, /id="status-filter"/u);
        assert.match(html, /id="priority-filter"/u);
        assert.match(html, /id="action-status"/u);
        assert.match(html, /id="settings-editor"/u);
        assert.match(html, /id="session-summary"/u);
        assert.match(html, /id="top-controls"/u);
        assert.match(html, /id="session-countdown"/u);
        assert.match(html, /api\/session/u);
        assert.match(html, /\.tab-buttons \{[^}]*flex-wrap: wrap/u);
        assert.match(html, /\.tab-buttons button\.active \{[^}]*background: var\(--ok\)/u);
        assert.match(html, /\.language-compact \.visually-hidden \{[^}]*position: absolute/u);
        assert.match(html, /\.session-action-row \{[^}]*display: grid/u);
        assert.match(html, /\.tab-buttons button \{[^}]*white-space: nowrap/u);
        assert.match(html, /\.session-compact \{[^}]*flex-direction: column/u);
        assert.match(html, /\.session-status-line/u);
        assert.match(html, /\.setting-buttons button, \.action-buttons button, \.switch-buttons button, #tasks button\[data-task-id\] \{[^}]*width: 138px/u);
        assert.match(html, /Gate Timeline/u);
        assert.match(html, /Artifacts/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI ordinary document controls validate and update one path at a time', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs', 'plan.md'), '# Plan\n', 'utf8');
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const headers = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const previewResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'preview', path: 'docs/plan.md' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as { status: string; proposed_paths: string[]; confirmation_phrase: string };
        assert.equal(preview.status, 'previewed');
        assert.deepEqual(preview.proposed_paths, ['CHANGELOG.md', 'docs/plan.md']);
        assert.equal(preview.confirmation_phrase, 'APPLY ORDINARY DOCS');

        const blockedResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'execute', path: 'docs/plan.md', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');

        const executeResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'execute', path: 'docs/plan.md', confirmation: 'APPLY ORDINARY DOCS' })
        });
        assert.equal(executeResponse.status, 200);
        assert.equal((await executeResponse.json() as { status: string }).status, 'executed');
        const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')).ordinary_doc_paths, ['CHANGELOG.md', 'docs/plan.md']);

        const missingResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'preview', path: 'docs/missing.md' })
        });
        assert.equal(missingResponse.status, 400);

        const removeResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'remove', mode: 'execute', path: 'docs/plan.md', confirmation: 'APPLY ORDINARY DOCS' })
        });
        assert.equal(removeResponse.status, 200);
        assert.deepEqual(JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')).ordinary_doc_paths, ['CHANGELOG.md']);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI file viewer opens only repository-relative files', async () => {
    const repoRoot = makeTempRepo();
    const outsideRoot = `${repoRoot}-outside`;
    writeRepo(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, 'secret.md'), '# Secret\n', 'utf8');
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const fileUrl = (filePath: string, token = actionToken): string => {
            return `${server.url}files?path=${encodeURIComponent(filePath)}&action_token=${encodeURIComponent(token)}`;
        };
        const fileHeaders = { referer: server.url };
        const ok = await fetch(fileUrl('AGENTS.md'), { headers: fileHeaders });
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /Agent instructions/u);

        const missingToken = await fetch(`${server.url}files?path=AGENTS.md`, { headers: fileHeaders });
        assert.equal(missingToken.status, 403);

        const badReferer = await fetch(fileUrl('AGENTS.md'), { headers: { referer: 'http://attacker.example/' } });
        assert.equal(badReferer.status, 403);

        const rejected = await fetch(fileUrl('../AGENTS.md'), { headers: fileHeaders });
        assert.equal(rejected.status, 404);

        if (tryCreateSymlink(path.join(outsideRoot, 'secret.md'), path.join(repoRoot, 'docs', 'outside-file.md'), 'file')) {
            const symlinkFile = await fetch(fileUrl('docs/outside-file.md'), { headers: fileHeaders });
            assert.equal(symlinkFile.status, 404);
        }

        if (tryCreateSymlink(outsideRoot, path.join(repoRoot, 'docs', 'outside-dir'), process.platform === 'win32' ? 'junction' : 'dir')) {
            const symlinkDirFile = await fetch(fileUrl('docs/outside-dir/secret.md'), { headers: fileHeaders });
            assert.equal(symlinkDirFile.status, 404);
        }
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
        fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

function tryCreateSymlink(target: string, linkPath: string, type: fs.symlink.Type): boolean {
    try {
        fs.symlinkSync(target, linkPath, type);
        return true;
    } catch (error: unknown) {
        if (error instanceof Error
            && 'code' in error
            && ['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(String((error as NodeJS.ErrnoException).code))) {
            return false;
        }
        throw error;
    }
}
