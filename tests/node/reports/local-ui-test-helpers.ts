import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'node:test';

interface ClosableLocalUiServer {
    close: () => Promise<void>;
}

const localUiTempRepos = new Set<string>();

afterEach(() => {
    let firstError: unknown = null;
    for (const repoRoot of Array.from(localUiTempRepos)) {
        try {
            removeLocalUiTempRepo(repoRoot);
        } catch (error: unknown) {
            if (firstError === null) {
                firstError = error;
            }
        }
    }
    if (firstError !== null) {
        throw firstError;
    }
});

export function makeLocalUiTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-ui-server-'));
    localUiTempRepos.add(repoRoot);
    return repoRoot;
}

export function removeLocalUiTempRepo(repoRoot: string | null | undefined): void {
    if (!repoRoot) {
        return;
    }
    fs.rmSync(repoRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
    localUiTempRepos.delete(repoRoot);
}

export async function cleanupLocalUiTestResources(options: {
    repoRoot?: string | null;
    server?: ClosableLocalUiServer | null;
    netServers?: Array<net.Server | null | undefined>;
}): Promise<void> {
    let firstError: unknown = null;
    const capture = (error: unknown) => {
        if (firstError === null) {
            firstError = error;
        }
    };

    if (options.server) {
        try {
            await options.server.close();
        } catch (error: unknown) {
            if (!isAlreadyClosedServerError(error)) {
                capture(error);
            }
        }
    }
    for (const server of options.netServers || []) {
        if (!server) {
            continue;
        }
        try {
            await closeNetServer(server);
        } catch (error: unknown) {
            if (!isAlreadyClosedServerError(error)) {
                capture(error);
            }
        }
    }
    try {
        removeLocalUiTempRepo(options.repoRoot);
    } catch (error: unknown) {
        capture(error);
    }

    if (firstError !== null) {
        throw firstError;
    }
}

function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function isAlreadyClosedServerError(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as Error & { code?: string }).code === 'ERR_SERVER_NOT_RUNNING';
}
