import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
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

test('local UI server skips all fetch-forbidden configured local ports', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    let firstSafePort = 0;
    for (let port = 6670; port <= 7200; port += 1) {
        const candidate = await reserveSpecificPort(port);
        if (candidate) {
            firstSafePort = port;
            await closeNetServer(candidate);
            break;
        }
    }
    assert.notEqual(firstSafePort, 0, 'expected at least one bindable safe local UI test port after fetch-forbidden range');
    const server = await startLocalUiServer({
        repoRoot,
        portStart: 6665,
        portEnd: firstSafePort
    });
    try {
        assert.equal(server.host, DEFAULT_UI_HOST);
        assert.equal(server.port, firstSafePort);
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
        await assert.rejects(
            () => startLocalUiServer({ repoRoot, port: 6679 }),
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
