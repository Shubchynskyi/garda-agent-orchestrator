import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import {
    DEFAULT_UI_HOST,
    startLocalUiServer
} from '../../../src/reports/local-ui-server';

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
            unavailable: unknown[];
        };
        assert.equal(report.tasks_tab.rows[0].task_id, 'T-100');
        assert.equal(report.tasks_tab.rows[0].detail.detail_status, 'skipped');
        assert.equal(report.unavailable.length, 0);

        const detailResponse = await fetch(`${server.url}api/tasks/T-100/detail`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json() as { task_id: string; detail_status: string };
        assert.equal(detail.task_id, 'T-100');
        assert.equal(detail.detail_status, 'loaded');
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
