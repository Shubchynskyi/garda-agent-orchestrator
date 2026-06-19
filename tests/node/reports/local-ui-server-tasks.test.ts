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
    writeLocalUiRepoFixture,
    writeLocalUiTaskQueue
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

    scrollIntoView(): void {
        // No-op for dashboard client tests.
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== 'button[data-task-id]'
            && selector !== 'button[data-action-id]'
            && selector !== 'button[data-setting-id]'
            && selector !== 'button[data-task-action-id]'
            && selector !== 'button[data-backup-action-id]'
            && selector !== 'button[data-file-path]'
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
                            : selector === 'button[data-file-path]'
                                ? 'file-path'
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
                                : selector === 'button[data-file-path]'
                                    ? 'filePath'
                                    : 'instructionTab';
            const modePattern = /data-action-mode="([^"]+)"/u;
            const settingModePattern = /data-setting-mode="([^"]+)"/u;
            const taskActionModePattern = /data-task-action-mode="([^"]+)"/u;
            const fileTargetPattern = /data-file-target="([^"]+)"/u;
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
                const fileTargetMatch = buttonHtml.match(fileTargetPattern);
                if (fileTargetMatch) {
                    button.dataset.fileTarget = fileTargetMatch[1];
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
const writeTaskQueue = writeLocalUiTaskQueue;

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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
            },
            backups_tab: {
                snapshots_root: 'garda-agent-orchestrator/runtime/update-rollbacks',
                snapshots_root_exists: true,
                auto_backup: {
                    enabled: true,
                    interval_days: 7,
                    keep_latest: 10
                },
                unavailable: [],
                rows: [
                    {
                        id: 'update-20260101-120000-000',
                        created_at: '2026-01-01T12:00:00.000Z',
                        size_human: '12 KB',
                        reason: 'update',
                        health: 'AVAILABLE',
                        health_message: null
                    }
                ]
            },
            project_memory_tab: {
                settings_config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
                memory_directory_path: 'garda-agent-orchestrator/live/docs/project-memory',
                advisory: {
                    prompt_path: 'template/docs/prompts/project-memory-optimization.md',
                    prompt_exists: true
                },
                settings: [],
                status: [],
                files: []
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
                },
                {
                    id: 'backup-restore:update-20260101-120000-000',
                    category: 'Backups',
                    label: 'Restore backup update-20260101-120000-000',
                    description: 'Restore workspace state from backup snapshot.',
                    command: 'node bin/garda.js rollback --snapshot-path runtime/update-rollbacks/update-20260101-120000-000 --target-root "."',
                    mutates: true,
                    enabled: true,
                    unavailable_reason: null,
                    requires_confirmation: true,
                    confirmation_phrase: 'RESTORE BACKUP update-20260101-120000-000'
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
                },
                {
                    id: 'auto-backup-enabled',
                    key: 'backups.auto_backup.enabled',
                    label: 'Auto-backup enabled',
                    description: 'Enable automatic update backups',
                    current_value: false,
                    value_type: 'boolean',
                    options: [
                        { value: 'true', label: 'true', description: 'Enable backups' },
                        { value: 'false', label: 'false', description: 'Disable backups' }
                    ],
                    flag: '--auto-backup-enabled',
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
        let sessionFetchFails = false;
        vm.runInNewContext(extractDashboardScript(html), {
            document: fakeDocument,
            window: {
                prompt: (message: string) => {
                    if (message.includes('RESTORE BACKUP update-20260101-120000-000')) {
                        return 'RESTORE BACKUP update-20260101-120000-000';
                    }
                    if (message.includes('APPLY GARDA SETTING')) {
                        return 'APPLY GARDA SETTING';
                    }
                    return null;
                },
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
            fetch: async (url: string, options?: { method?: string }) => {
                if (sessionFetchFails && (url === '/api/session' || url === '/api/session/activity' || url === '/api/session/shutdown')) {
                    throw new Error('session unavailable');
                }
                if (url.startsWith('/files?path=')) {
                    return {
                        ok: true,
                        status: 200,
                        text: async () => '# Project Memory Optimization Prompt\n\nUse this as a project map.',
                        json: async () => ({})
                    };
                }
                return ({
                ok: true,
                status: 200,
                text: async () => '',
                json: async () => {
                    if (url === '/api/session' || url === '/api/session/activity' || url === '/api/session/shutdown') {
                        return session;
                    }
                    if (url === '/api/report') {
                        return report;
                    }
                    if (url === '/api/actions') {
                        if (options?.method === 'POST') {
                            return {
                                action_id: 'backup-restore:update-20260101-120000-000',
                                status: 'executed',
                                command: 'node bin/garda.js rollback --snapshot-path runtime/update-rollbacks/update-20260101-120000-000 --target-root "."',
                                stdout: 'verbose rollback output that should stay hidden in the backup status panel',
                                audit_path: 'runtime/ui-actions/audit.jsonl'
                            };
                        }
                        return actions;
                    }
                    if (url === '/api/settings') {
                        if (options?.method === 'POST') {
                            return {
                                setting_id: 'auto-backup-enabled',
                                status: 'executed',
                                label: 'Auto-backup enabled',
                                key: 'backups.auto_backup.enabled',
                                command: 'node bin/garda.js workflow set --auto-backup-enabled true --target-root "."',
                                stdout: 'verbose workflow output that should stay hidden in the backup status panel',
                                current_value: false,
                                proposed_value: true,
                                changed_keys: ['backups.auto_backup.enabled'],
                                audit_path: 'runtime/ui-actions/audit.jsonl'
                            };
                        }
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
                });
            }
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
        assert.doesNotMatch(fakeDocument.elements['settings-editor'].innerHTML, /id="setting-input-workflow-auto-backup-enabled"/u);
        assert.match(fakeDocument.elements.instructions.innerHTML, /Read-only/u);
        assert.equal(fakeDocument.elements.actions.innerHTML, '');
        assert.doesNotMatch(fakeDocument.elements.actions.innerHTML, /backup-restore/u);
        assert.doesNotMatch(fakeDocument.elements.actions.innerHTML, /rollback --snapshot-path/u);
        assert.match(fakeDocument.elements['backups-table'].innerHTML, /data-backup-action-id="backup-restore:update-20260101-120000-000"/u);
        const backupRestoreButton = fakeDocument.elements['backups-table'].querySelectorAll('button[data-backup-action-id]')
            .find((button) => button.dataset.backupActionId === 'backup-restore:update-20260101-120000-000' && button.dataset.actionMode === 'execute');
        assert.ok(backupRestoreButton);
        await backupRestoreButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements['backup-action-status'].innerHTML, />OK</u);
        assert.doesNotMatch(fakeDocument.elements['backup-action-status'].innerHTML, /rollback --snapshot-path/u);
        assert.doesNotMatch(fakeDocument.elements['backup-action-status'].innerHTML, /verbose rollback output/u);
        assert.match(fakeDocument.elements['backups-settings'].innerHTML, /data-setting-id="auto-backup-enabled"/u);
        assert.match(fakeDocument.elements['backups-settings'].innerHTML, /data-setting-control-scope="backups"/u);
        assert.match(fakeDocument.elements['backups-settings'].innerHTML, /id="setting-input-backups-auto-backup-enabled"/u);
        assert.doesNotMatch(fakeDocument.elements['backups-settings'].innerHTML, /id="setting-input-workflow-auto-backup-enabled"/u);
        assert.doesNotMatch(fakeDocument.elements['backups-settings'].innerHTML, /id="setting-input-auto-backup-enabled"/u);
        const backupSettingSaveButton = fakeDocument.elements['backups-settings'].querySelectorAll('button[data-setting-id]')
            .find((button) => button.dataset.settingId === 'auto-backup-enabled' && button.dataset.settingMode === 'execute');
        assert.ok(backupSettingSaveButton);
        await backupSettingSaveButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements['backup-action-status'].innerHTML, />OK</u);
        assert.doesNotMatch(fakeDocument.elements['backup-action-status'].innerHTML, /workflow set --auto-backup-enabled/u);
        assert.doesNotMatch(fakeDocument.elements['backup-action-status'].innerHTML, /verbose workflow output/u);
        assert.match(fakeDocument.elements['garda-switch-panel'].innerHTML, /Switch action is hidden/u);
        assert.doesNotMatch(fakeDocument.elements['garda-switch-panel'].innerHTML, /data-action-id="garda-on"/u);
        assert.doesNotMatch(fakeDocument.elements['garda-switch-panel'].innerHTML, /data-action-id="garda-off"/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Shutdown in/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /15m/u);
        assert.doesNotMatch(fakeDocument.elements['session-summary'].innerHTML, /16m/u);
        assert.match(fakeDocument.elements['language-select'].innerHTML, /Русский/u);
        assert.match(fakeDocument.elements['ui-notice'].textContent, /127\.0\.0\.1/u);

        const projectMemoryButton = fakeDocument.querySelectorAll('nav button[data-tab]')[3];
        await projectMemoryButton.dispatch('click');
        assert.match(fakeDocument.elements['project-memory'].innerHTML, /Project memory optimization/u);
        assert.match(fakeDocument.elements['project-memory'].innerHTML, /template\/docs\/prompts\/project-memory-optimization\.md/u);
        assert.match(fakeDocument.elements['project-memory'].innerHTML, /data-file-path="template\/docs\/prompts\/project-memory-optimization\.md"/u);
        const promptOpenButton = fakeDocument.elements['project-memory'].querySelectorAll('button[data-file-path]')
            .find((button) => button.dataset.filePath === 'template/docs/prompts/project-memory-optimization.md');
        assert.ok(promptOpenButton);
        assert.equal(promptOpenButton.dataset.fileTarget, 'memory-file-content');
        await promptOpenButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements['memory-file-content'].innerHTML, /Project Memory Optimization Prompt/u);
        assert.match(fakeDocument.elements['memory-file-content'].innerHTML, /template\/docs\/prompts\/project-memory-optimization\.md/u);

        const taskButton = tasksNode.querySelectorAll('button[data-task-id]')[0];
        await taskButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements.detail.innerHTML, /Gate Timeline/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Runtime diagnostics/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Full-suite validation/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /2m 3\.5s/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Average duration/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /5m 43\.2s/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Recommended timeout/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /7m 56s/u);
        Object.assign(detail.full_suite_validation.timeout_forecast as Record<string, unknown>, {
            history_path: 'runtime/full-suite-duration-history.json',
            sample_count: 0,
            average_duration_seconds: null,
            high_watermark_duration_seconds: null,
            recommended_timeout_seconds: 600,
            safety_margin_seconds: null,
            recommendation_source: 'config_timeout',
            configured_timeout_seconds: 600,
            warning: null
        });
        detail.full_suite_validation.timeout_forecast_label = 'Recommended full-suite command timeout: 600s (no recent matching full-suite duration history; using configured timeout).';
        await taskButton.dispatch('click');
        await flushPromises();
        assert.match(fakeDocument.elements.detail.innerHTML, /Configured timeout<\/th><td>10m<\/td>/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Average duration<\/th><td>-<\/td>/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /High-watermark duration<\/th><td>-<\/td>/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Recommended timeout<\/th><td>10m<\/td>/u);
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
        assert.match(fakeDocument.elements['task-action-status'].innerHTML, /Dry-run only/u);
        assert.match(fakeDocument.elements['task-action-status'].innerHTML, /runtime\/ui-actions\/audit\.jsonl/u);
        assert.doesNotMatch(fakeDocument.elements['task-action-status'].innerHTML, /node bin\/garda\.js task T-100 stats/u);

        fakeDocument.elements['language-select'].value = 'ru';
        await fakeDocument.elements['language-select'].dispatch('change');
        assert.deepEqual(storedLanguageCalls.at(-1), ['garda.ui.language', 'ru']);
        assert.match(fakeDocument.elements.detail.innerHTML, /События/u);
        assert.match(fakeDocument.elements.detail.innerHTML, /Статус полной проверки/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /Выключение через/u);

        sessionFetchFails = true;
        await fakeDocument.elements['session-activity'].dispatch('click');
        await flushPromises();
        assert.doesNotMatch(fakeDocument.elements['session-summary'].innerHTML, /Выключение через|Shutdown in/u);
        assert.match(fakeDocument.elements['session-summary'].innerHTML, /сервер недоступен|server is unavailable/u);
        assert.equal(fakeDocument.elements['session-countdown'].value, '0');
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
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
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});
