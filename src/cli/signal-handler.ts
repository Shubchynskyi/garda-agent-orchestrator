import * as fs from 'node:fs';

import { EXIT_SIGNAL_INTERRUPT } from './exit-codes';

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

function onSignal(sig: NodeJS.Signals | null) {
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
    // SIGINT = 2  → 130, SIGTERM = 15 → 143, SIGHUP = 1 → 129.
    const exitCode = computeSignalExitCode(sig);
    process.exit(exitCode);
}

const SIGNAL_EXIT_CODE_MAP: Readonly<Record<string, number>> = Object.freeze({
    SIGHUP: 1,
    SIGINT: 2,
    SIGPIPE: 13,
    SIGTERM: 15,
    SIGBREAK: 21,
    SIGWINCH: 28,
});

export function computeSignalExitCode(sig: NodeJS.Signals | null): number {
    if (!sig) {
        return EXIT_SIGNAL_INTERRUPT;
    }
    const signalNumber = SIGNAL_EXIT_CODE_MAP[sig];
    if (signalNumber != null) {
        return 128 + signalNumber;
    }
    return EXIT_SIGNAL_INTERRUPT;
}

export function registerTempRoot(dirPath: string): () => void {
    const fn = function () {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (_e) { /* best effort */ }
    };
    return registerCleanup(fn);
}
