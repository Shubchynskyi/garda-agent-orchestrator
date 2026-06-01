import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isCanonicalTaskId } from '../../core/task-ids';
import {
    buildReportDataContract,
    buildReportTaskDetail,
    type ReportDataContract,
    type ReportTaskDetail
} from '../report-data-contract';
import {
    buildUiActionsPayload,
    buildUiSettingsPayload,
    handleUiActionRequest,
    handleUiSettingRequest,
    handleUiTaskActionRequest,
    sendApiError,
    type LocalUiServerRuntimeOptions
} from './ui-action-http';
import {
    runUiActionCommand,
    type UiActionDefinition,
    type UiActionRunner,
    type UiActionRunnerResult
} from './ui-action-registry';
import { renderLocalUiHtml } from './ui-dashboard-html';
import {
    DEFAULT_LOCAL_UI_LANGUAGE,
    normalizeLocalUiLanguage,
    type LocalUiLanguage
} from './ui-i18n';

export type {
    UiActionDefinition,
    UiActionRunner,
    UiActionRunnerResult
};

export const DEFAULT_UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT_START = 17340;
export const DEFAULT_UI_PORT_END = 17359;
export const DEFAULT_UI_IDLE_MINUTES = 15;
export const DEFAULT_UI_IDLE_WARNING_SECONDS = 60;
const DYNAMIC_PORT_RETRY_LIMIT = 25;
const BROWSER_UNSAFE_PORTS = new Set<number>([
    1,
    7,
    9,
    11,
    13,
    15,
    17,
    19,
    20,
    21,
    22,
    23,
    25,
    37,
    42,
    43,
    53,
    69,
    77,
    79,
    87,
    95,
    101,
    102,
    103,
    104,
    109,
    110,
    111,
    113,
    115,
    117,
    119,
    123,
    135,
    137,
    139,
    143,
    161,
    179,
    389,
    427,
    465,
    512,
    513,
    514,
    515,
    526,
    530,
    531,
    532,
    540,
    548,
    554,
    556,
    563,
    587,
    601,
    636,
    989,
    990,
    993,
    995,
    1719,
    1720,
    1723,
    2049,
    3659,
    4045,
    5060,
    5061,
    6000,
    6566,
    6665,
    6666,
    6667,
    6668,
    6669,
    6697,
    10080
]);

export interface StartLocalUiServerOptions {
    repoRoot: string;
    host?: string;
    port?: number | null;
    portStart?: number;
    portEnd?: number;
    actionsEnabled?: boolean;
    idleShutdownEnabled?: boolean;
    idleMinutes?: number | null;
    idleWarningSeconds?: number | null;
    language?: LocalUiLanguage | null;
    actionRunner?: UiActionRunner;
}

export interface LocalUiServer {
    server: http.Server;
    host: string;
    port: number;
    url: string;
    actionsEnabled: boolean;
    idleShutdownEnabled: boolean;
    idleMinutes: number;
    idleWarningSeconds: number;
    language: LocalUiLanguage;
    close: () => Promise<void>;
}

interface ReportSnapshotCache {
    fingerprint: string | null;
    report: ReportDataContract | null;
}

interface LocalUiSessionSnapshot {
    enabled: boolean;
    state: 'active' | 'warning' | 'stopping' | 'disabled';
    last_activity_at: string;
    idle_minutes: number;
    warning_seconds: number;
    idle_deadline_at: string | null;
    shutdown_deadline_at: string | null;
    seconds_until_warning: number | null;
    seconds_until_shutdown: number | null;
    stop_message: string;
}

interface LocalUiSessionController {
    snapshot: () => LocalUiSessionSnapshot;
    recordActivity: () => LocalUiSessionSnapshot;
    requestShutdown: () => LocalUiSessionSnapshot;
    dispose: () => void;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: http.ServerResponse, html: string): void {
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(html);
}

function sendText(response: http.ServerResponse, statusCode: number, body: string): void {
    response.writeHead(statusCode, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(body);
}

function buildReport(repoRoot: string): ReportDataContract {
    return buildReportDataContract({
        repoRoot,
        maxDetailedTasks: 0
    });
}

function statFingerprint(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return `${filePath}:missing`;
        }
        throw error;
    }
}

function buildSnapshotFingerprint(repoRoot: string): string {
    return [
        statFingerprint(path.join(repoRoot, 'TASK.md')),
        statFingerprint(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'))
    ].join('|');
}

function getCachedReport(repoRoot: string, cache: ReportSnapshotCache): ReportDataContract {
    const fingerprint = buildSnapshotFingerprint(repoRoot);
    if (cache.report && cache.fingerprint === fingerprint) {
        return cache.report;
    }
    const report = buildReport(repoRoot);
    cache.fingerprint = fingerprint;
    cache.report = report;
    return report;
}

function findTask(report: ReportDataContract, taskId: string): boolean {
    return report.tasks_tab.rows.some((row) => row.task_id === taskId);
}

function buildLocalUiSessionController(options: {
    idleShutdownEnabled: boolean;
    idleMinutes: number;
    idleWarningSeconds: number;
    closeServer: () => void;
}): LocalUiSessionController {
    const startedEpochMs = Date.now();
    const startedMonotonicMs = performance.now();
    const idleTimeoutMs = options.idleMinutes * 60 * 1000;
    const warningDurationMs = options.idleWarningSeconds * 1000;
    const stopMessage = 'The local Garda UI server has stopped. Rerun `garda ui` from a terminal to launch it again.';
    let lastActivityAtMs = currentTimeMs();
    let warningStartedAtMs: number | null = null;
    let shutdownDeadlineAtMs: number | null = null;
    let stopping = false;
    let timer: NodeJS.Timeout | null = null;

    function currentTimeMs(): number {
        return startedEpochMs + performance.now() - startedMonotonicMs;
    }

    function iso(ms: number | null): string | null {
        return ms === null ? null : new Date(ms).toISOString();
    }

    function secondsUntil(targetMs: number | null, nowMs: number): number | null {
        if (targetMs === null) {
            return null;
        }
        return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
    }

    function enterWarning(nowMs: number): void {
        if (!options.idleShutdownEnabled || stopping || warningStartedAtMs !== null) {
            return;
        }
        warningStartedAtMs = nowMs;
        shutdownDeadlineAtMs = nowMs + warningDurationMs;
    }

    function schedule(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!options.idleShutdownEnabled || stopping) {
            return;
        }
        const nowMs = currentTimeMs();
        const nextTargetMs = shutdownDeadlineAtMs ?? lastActivityAtMs + idleTimeoutMs;
        const delayMs = Math.max(50, Math.min(nextTargetMs - nowMs, 2 ** 31 - 1));
        timer = setTimeout(checkExpiry, delayMs);
        timer.unref();
    }

    function checkExpiry(): void {
        if (!options.idleShutdownEnabled || stopping) {
            return;
        }
        const nowMs = currentTimeMs();
        if (shutdownDeadlineAtMs !== null && nowMs >= shutdownDeadlineAtMs) {
            requestShutdown();
            return;
        }
        if (nowMs >= lastActivityAtMs + idleTimeoutMs) {
            enterWarning(nowMs);
        }
        schedule();
    }

    function requestShutdown(): LocalUiSessionSnapshot {
        if (!stopping) {
            stopping = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            setImmediate(options.closeServer);
        }
        return snapshot();
    }

    function snapshot(): LocalUiSessionSnapshot {
        const nowMs = currentTimeMs();
        if (options.idleShutdownEnabled && !stopping && nowMs >= lastActivityAtMs + idleTimeoutMs) {
            enterWarning(nowMs);
        }
        if (options.idleShutdownEnabled && !stopping && shutdownDeadlineAtMs !== null && nowMs >= shutdownDeadlineAtMs) {
            return requestShutdown();
        }
        const idleDeadlineAtMs = options.idleShutdownEnabled ? lastActivityAtMs + idleTimeoutMs : null;
        return {
            enabled: options.idleShutdownEnabled,
            state: !options.idleShutdownEnabled ? 'disabled' : stopping ? 'stopping' : warningStartedAtMs === null ? 'active' : 'warning',
            last_activity_at: new Date(lastActivityAtMs).toISOString(),
            idle_minutes: options.idleMinutes,
            warning_seconds: options.idleWarningSeconds,
            idle_deadline_at: iso(idleDeadlineAtMs),
            shutdown_deadline_at: iso(shutdownDeadlineAtMs),
            seconds_until_warning: warningStartedAtMs === null ? secondsUntil(idleDeadlineAtMs, nowMs) : 0,
            seconds_until_shutdown: secondsUntil(shutdownDeadlineAtMs, nowMs),
            stop_message: stopMessage
        };
    }

    function recordActivity(): LocalUiSessionSnapshot {
        if (!stopping) {
            lastActivityAtMs = currentTimeMs();
            warningStartedAtMs = null;
            shutdownDeadlineAtMs = null;
            schedule();
        }
        return snapshot();
    }

    schedule();
    return {
        snapshot,
        recordActivity,
        requestShutdown,
        dispose: () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
    };
}

function assertUiPostBoundary(request: http.IncomingMessage, actionToken: string): void {
    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    const origin = String(request.headers.origin || '');
    const host = String(request.headers.host || '');
    const token = String(request.headers['x-garda-action-token'] || '');
    if (!contentType.startsWith('application/json') || token !== actionToken) {
        throw new Error('Session request rejected by local UI boundary.');
    }
    if (!host.startsWith(`${DEFAULT_UI_HOST}:`) || (origin && origin !== `http://${host}`)) {
        throw new Error('Session request rejected by local UI boundary.');
    }
}

export function createLocalUiServer(repoRoot: string, runtimeOptions?: Partial<LocalUiServerRuntimeOptions> & {
    idleShutdownEnabled?: boolean;
    idleMinutes?: number | null;
    idleWarningSeconds?: number | null;
    language?: LocalUiLanguage | null;
}): http.Server {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const options: LocalUiServerRuntimeOptions = {
        actionsEnabled: runtimeOptions?.actionsEnabled === true,
        actionRunner: runtimeOptions?.actionRunner || runUiActionCommand,
        actionToken: crypto.randomBytes(32).toString('hex')
    };
    const reportCache: ReportSnapshotCache = {
        fingerprint: null,
        report: null
    };
    const language = normalizeLocalUiLanguage(runtimeOptions?.language || DEFAULT_LOCAL_UI_LANGUAGE);
    let server: http.Server;
    const session = buildLocalUiSessionController({
        idleShutdownEnabled: runtimeOptions?.idleShutdownEnabled !== false,
        idleMinutes: runtimeOptions?.idleMinutes ?? DEFAULT_UI_IDLE_MINUTES,
        idleWarningSeconds: runtimeOptions?.idleWarningSeconds ?? DEFAULT_UI_IDLE_WARNING_SECONDS,
        closeServer: () => server.close()
    });
    server = http.createServer((request, response) => {
        if (!request.url) {
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        const parsedUrl = new URL(request.url, `http://${DEFAULT_UI_HOST}`);
        const pathname = parsedUrl.pathname;
        if (request.method === 'POST' && pathname === '/api/session/activity') {
            try {
                assertUiPostBoundary(request, options.actionToken);
                sendJson(response, 200, session.recordActivity());
            } catch (error: unknown) {
                sendApiError(response, 403, error instanceof Error ? error.message : String(error), 'session_boundary_rejected');
            }
            return;
        }
        if (request.method === 'POST' && pathname === '/api/session/shutdown') {
            try {
                assertUiPostBoundary(request, options.actionToken);
                sendJson(response, 200, session.requestShutdown());
            } catch (error: unknown) {
                sendApiError(response, 403, error instanceof Error ? error.message : String(error), 'session_boundary_rejected');
            }
            return;
        }
        if (request.method === 'POST' && pathname === '/api/actions') {
            handleUiActionRequest(request, response, resolvedRepoRoot, options).catch((error: unknown) => {
                sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_action_request');
            });
            return;
        }
        if (request.method === 'POST' && pathname === '/api/settings') {
            handleUiSettingRequest(request, response, resolvedRepoRoot, options).catch((error: unknown) => {
                sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_setting_request');
            });
            return;
        }
        const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/actions$/u);
        if (request.method === 'POST' && taskActionMatch) {
            const taskId = decodeTaskIdSegment(taskActionMatch[1]);
            if (taskId === null || !isCanonicalTaskId(taskId)) {
                sendApiError(response, 400, 'Invalid task id.', 'invalid_task_id');
                return;
            }
            const report = getCachedReport(resolvedRepoRoot, reportCache);
            if (!findTask(report, taskId)) {
                sendApiError(response, 404, 'Task not found.', 'task_not_found');
                return;
            }
            handleUiTaskActionRequest(request, response, resolvedRepoRoot, taskId, options).catch((error: unknown) => {
                sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_task_action_request');
            });
            return;
        }
        if (request.method !== 'GET') {
            if (pathname.startsWith('/api/')) {
                sendApiError(response, 405, 'Only GET is supported.', 'method_not_allowed');
                return;
            }
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        if (pathname === '/') {
            sendHtml(response, renderLocalUiHtml(options.actionsEnabled, options.actionToken, language));
            return;
        }
        if (pathname === '/api/session') {
            sendJson(response, 200, session.snapshot());
            return;
        }
        if (pathname === '/api/report') {
            sendJson(response, 200, getCachedReport(resolvedRepoRoot, reportCache));
            return;
        }
        if (pathname === '/api/actions') {
            sendJson(response, 200, buildUiActionsPayload(resolvedRepoRoot, options.actionsEnabled));
            return;
        }
        if (pathname === '/api/settings') {
            sendJson(response, 200, buildUiSettingsPayload(resolvedRepoRoot, options.actionsEnabled));
            return;
        }
        const detailMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/detail$/u);
        if (detailMatch) {
            const taskId = decodeTaskIdSegment(detailMatch[1]);
            if (taskId === null || !isCanonicalTaskId(taskId)) {
                sendApiError(response, 400, 'Invalid task id.', 'invalid_task_id');
                return;
            }
            const report = getCachedReport(resolvedRepoRoot, reportCache);
            if (!findTask(report, taskId)) {
                sendApiError(response, 404, 'Task not found.', 'task_not_found');
                return;
            }
            const detail: ReportTaskDetail = buildReportTaskDetail({
                repoRoot: resolvedRepoRoot,
                taskId
            });
            sendJson(response, 200, detail);
            return;
        }
        if (pathname.startsWith('/api/')) {
            sendApiError(response, 404, 'Not found.', 'not_found');
            return;
        }
        sendText(response, 404, 'Not found.');
    });
    server.once('close', () => session.dispose());
    return server;
}

function decodeTaskIdSegment(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch (error) {
        if (error instanceof URIError) {
            return null;
        }
        throw error;
    }
}

function listenOnPort(server: http.Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function validatePort(port: number, label: string): void {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`${label} must be an integer from 0 to 65535.`);
    }
}

function isBrowserUnsafePort(port: number): boolean {
    return BROWSER_UNSAFE_PORTS.has(port);
}

export async function startLocalUiServer(options: StartLocalUiServerOptions): Promise<LocalUiServer> {
    const host = options.host || DEFAULT_UI_HOST;
    if (host !== DEFAULT_UI_HOST) {
        throw new Error('garda ui only supports binding to 127.0.0.1.');
    }
    const portStart = options.portStart ?? DEFAULT_UI_PORT_START;
    const portEnd = options.portEnd ?? DEFAULT_UI_PORT_END;
    validatePort(portStart, 'portStart');
    validatePort(portEnd, 'portEnd');
    if (portEnd < portStart) {
        throw new Error('portEnd must be greater than or equal to portStart.');
    }
    const requestedPort = options.port;
    const explicitPort = requestedPort !== null && requestedPort !== undefined;
    const requestedDynamicPort = explicitPort && requestedPort === 0;
    const rangeCandidatePorts = Array.from({ length: portEnd - portStart + 1 }, (_, index) => portStart + index);
    const candidatePorts = requestedDynamicPort
        ? [0, ...rangeCandidatePorts.filter((port) => port !== 0)]
        : !explicitPort
        ? rangeCandidatePorts
        : [requestedPort];
    let lastError: Error | null = null;
    for (const port of candidatePorts) {
        validatePort(port, 'port');
        const candidateIsExplicitPort = explicitPort && (!requestedDynamicPort || port === 0);
        if (port !== 0 && isBrowserUnsafePort(port)) {
            lastError = new Error(`Port ${port} is not browser-safe for localhost UI fetch/navigation.`);
            if (candidateIsExplicitPort) {
                throw lastError;
            }
            continue;
        }
        const dynamicRetryCount = port === 0 ? DYNAMIC_PORT_RETRY_LIMIT : 1;
        for (let retryIndex = 0; retryIndex < dynamicRetryCount; retryIndex += 1) {
            const server = createLocalUiServer(options.repoRoot, {
                actionsEnabled: options.actionsEnabled === true,
                actionRunner: options.actionRunner,
                idleShutdownEnabled: options.idleShutdownEnabled !== false,
                idleMinutes: options.idleMinutes ?? DEFAULT_UI_IDLE_MINUTES,
                idleWarningSeconds: options.idleWarningSeconds ?? DEFAULT_UI_IDLE_WARNING_SECONDS,
                language: normalizeLocalUiLanguage(options.language || DEFAULT_LOCAL_UI_LANGUAGE)
            });
            try {
                const actualPort = await listenOnPort(server, host, port);
                if (isBrowserUnsafePort(actualPort)) {
                    lastError = new Error(`Port ${actualPort} is not browser-safe for localhost UI fetch/navigation.`);
                    await closeServer(server).catch(() => undefined);
                    continue;
                }
                return {
                    server,
                    host,
                    port: actualPort,
                    url: `http://${host}:${actualPort}/`,
                    actionsEnabled: options.actionsEnabled === true,
                    idleShutdownEnabled: options.idleShutdownEnabled !== false,
                    idleMinutes: options.idleMinutes ?? DEFAULT_UI_IDLE_MINUTES,
                    idleWarningSeconds: options.idleWarningSeconds ?? DEFAULT_UI_IDLE_WARNING_SECONDS,
                    language: normalizeLocalUiLanguage(options.language || DEFAULT_LOCAL_UI_LANGUAGE),
                    close: () => closeServer(server)
                };
            } catch (error: unknown) {
                lastError = error instanceof Error ? error : new Error(String(error));
                await closeServer(server).catch(() => undefined);
                if (candidateIsExplicitPort || !('code' in (lastError as Error & { code?: string })) || (lastError as Error & { code?: string }).code !== 'EADDRINUSE') {
                    throw lastError;
                }
            }
        }
    }
    throw new Error(`No available localhost UI port in range ${portStart}-${portEnd}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

export function formatLocalUiServerOutput(server: LocalUiServer): string {
    return [
        'GARDA_UI',
        `Url: ${server.url}`,
        `Host: ${server.host}`,
        `Port: ${server.port}`,
        `Mode: ${server.actionsEnabled ? 'controlled-actions' : 'read-only'}`,
        `Language: ${server.language}`,
        `IdleShutdown: ${server.idleShutdownEnabled ? `enabled; idle=${server.idleMinutes}m; warning=${server.idleWarningSeconds}s` : 'disabled'}`,
        'Stop: Ctrl+C'
    ].join('\n');
}
