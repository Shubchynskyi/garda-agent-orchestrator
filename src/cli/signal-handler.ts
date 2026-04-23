import * as fs from 'node:fs';

const cleanupCallbacks: Set<() => void> = new Set();

let controller: AbortController | null = null;

let shuttingDown = false;

let installed = false;
export function registerCleanup(fn: () => void): () => void {
    cleanupCallbacks.add(fn);
    return function dispose() {
        cleanupCallbacks.delete(fn);
    };
}

export function unregisterCleanup(fn: () => void): void {
    cleanupCallbacks.delete(fn);
}

export function getShutdownSignal(): AbortSignal | null {
    return controller ? controller.signal : null;
}

export function installSignalHandlers() {
    if (installed) return;
    installed = true;

    controller = new AbortController();

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // SIGBREAK is Windows-specific (Ctrl+Break). Only listen when supported.
    if (process.platform === 'win32') {
        try {
            process.on('SIGBREAK', onSignal);
        } catch (_e) {
            // Silently ignore if SIGBREAK is unsupported in this Node build.
        }
    }
}

export function uninstallSignalHandlers() {
    if (!installed) return;
    installed = false;

    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (process.platform === 'win32') {
        try {
            process.removeListener('SIGBREAK', onSignal);
        } catch (_e) { /* ignore */ }
    }

    cleanupCallbacks.clear();
    controller = null;
    shuttingDown = false;
}

function onSignal() {
    if (shuttingDown) return;
    shuttingDown = true;

    // Fire AbortController so in-flight async work can cancel early.
    if (controller && !controller.signal.aborted) {
        try { controller.abort(); } catch (_e) { /* ignore */ }
    }

    // Run every registered cleanup callback (best-effort, synchronous).
    for (const fn of cleanupCallbacks) {
        try {
            fn();
        } catch (_e) {
            // Cleanup must never throw during shutdown – ignore errors.
        }
    }
    cleanupCallbacks.clear();

    // Exit with conventional signal exit code (128 + signal number).
    // SIGINT = 2, SIGTERM = 15 – use 130 as the common Ctrl+C code.
    process.exit(130);
}

export function registerTempRoot(dirPath: string): () => void {
    const fn = function () {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (_e) { /* best effort */ }
    };
    return registerCleanup(fn);
}
