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
        assert.ok(list.settings.some((setting) => setting.id === 'project-memory-max-compact-summary-chars'));
        assert.ok(list.settings.some((setting) => setting.key === 'full_suite_validation.enabled'));
        const scopeProfiles = list.settings.find((setting) => setting.id === 'scope-budget-profiles');
        assert.ok(scopeProfiles);
        assert.equal(scopeProfiles.value_type, 'enum_list');
        assert.ok(scopeProfiles.options.some((option) => option.value === 'strict'));

        const compilePreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'compile-gate-command', mode: 'preview', value: 'npm run typecheck' })
        });
        assert.equal(compilePreviewResponse.status, 200);
        const compilePreview = await compilePreviewResponse.json() as {
            key: string;
            proposed_value: string;
            command: string;
            changed_keys: string[];
        };
        assert.equal(compilePreview.key, 'compile_gate.command');
        assert.equal(compilePreview.proposed_value, 'npm run typecheck');
        assert.deepEqual(compilePreview.changed_keys, ['compile_gate.command']);
        assert.match(compilePreview.command, /workflow set --compile-gate-command "npm run typecheck"/u);

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

        const memoryLimitPreviewResponse = await fetch(`${server.url}api/settings`, {
            method: 'POST',
            headers: actionHeaders,
            body: JSON.stringify({ setting_id: 'project-memory-max-compact-summary-chars', mode: 'preview', value: 20000 })
        });
        assert.equal(memoryLimitPreviewResponse.status, 200);
        const memoryLimitPreview = await memoryLimitPreviewResponse.json() as {
            key: string;
            proposed_value: number;
            command: string;
            changed_keys: string[];
        };
        assert.equal(memoryLimitPreview.key, 'project_memory_maintenance.max_compact_summary_chars');
        assert.equal(memoryLimitPreview.proposed_value, 20000);
        assert.deepEqual(memoryLimitPreview.changed_keys, ['project_memory_maintenance.max_compact_summary_chars']);
        assert.match(memoryLimitPreview.command, /workflow set --project-memory-max-compact-summary-chars 20000/u);
        assert.doesNotMatch(memoryLimitPreview.command, /workflow-config\.json/u);

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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
