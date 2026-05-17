import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';
import { isCanonicalTaskId } from '../core/task-ids';
import {
    buildReportDataContract,
    buildReportTaskDetail,
    type ReportDataContract,
    type ReportTaskDetail
} from './report-data-contract';
import {
    buildUiActionsPayload,
    buildUiSettingsPayload,
    handleUiActionRequest,
    handleUiSettingRequest,
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

export type {
    UiActionDefinition,
    UiActionRunner,
    UiActionRunnerResult
};

export const DEFAULT_UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT_START = 17340;
export const DEFAULT_UI_PORT_END = 17359;

export interface StartLocalUiServerOptions {
    repoRoot: string;
    host?: string;
    port?: number | null;
    portStart?: number;
    portEnd?: number;
    actionsEnabled?: boolean;
    actionRunner?: UiActionRunner;
}

export interface LocalUiServer {
    server: http.Server;
    host: string;
    port: number;
    url: string;
    actionsEnabled: boolean;
    close: () => Promise<void>;
}

interface ReportSnapshotCache {
    fingerprint: string | null;
    report: ReportDataContract | null;
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

export function createLocalUiServer(repoRoot: string, runtimeOptions?: Partial<LocalUiServerRuntimeOptions>): http.Server {
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
    return http.createServer((request, response) => {
        if (!request.url) {
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        const parsedUrl = new URL(request.url, `http://${DEFAULT_UI_HOST}`);
        const pathname = parsedUrl.pathname;
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
        if (request.method !== 'GET') {
            if (pathname.startsWith('/api/')) {
                sendApiError(response, 405, 'Only GET is supported.', 'method_not_allowed');
                return;
            }
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        if (pathname === '/') {
            sendHtml(response, renderLocalUiHtml(options.actionsEnabled, options.actionToken));
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
    const candidatePorts = options.port === null || options.port === undefined
        ? Array.from({ length: portEnd - portStart + 1 }, (_, index) => portStart + index)
        : [options.port];
    let lastError: Error | null = null;
    for (const port of candidatePorts) {
        validatePort(port, 'port');
        const server = createLocalUiServer(options.repoRoot, {
            actionsEnabled: options.actionsEnabled === true,
            actionRunner: options.actionRunner
        });
        try {
            const actualPort = await listenOnPort(server, host, port);
            return {
                server,
                host,
                port: actualPort,
                url: `http://${host}:${actualPort}/`,
                actionsEnabled: options.actionsEnabled === true,
                close: () => closeServer(server)
            };
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await closeServer(server).catch(() => undefined);
            if (options.port !== null && options.port !== undefined || !('code' in (lastError as Error & { code?: string })) || (lastError as Error & { code?: string }).code !== 'EADDRINUSE') {
                throw lastError;
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
        'Stop: Ctrl+C'
    ].join('\n');
}
