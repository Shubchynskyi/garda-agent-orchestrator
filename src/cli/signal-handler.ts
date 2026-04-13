import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// CLI signal handler – temp-root cleanup & cancellation on SIGINT/SIGTERM
// ---------------------------------------------------------------------------

const cleanupCallbacks: Set<() => void> = new Set();

let controller: AbortController | null = null;

let shuttingDown = false;

let installed = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a cleanup callback that will run when a termination signal fires.
 * Typically used to remove temporary directories.
 * Returns a dispose function that unregisters the callback.
 *
 * @param {() => void} fn
 * @returns {() => void} dispose – call to unregister
 */
export function registerCleanup(fn: () => void): () => void {
    cleanupCallbacks.add(fn);
    return function dispose() {
        cleanupCallbacks.delete(fn);
    };
}

/**
 * Unregister a previously registered cleanup callback.
 * @param {() => void} fn
 */
export function unregisterCleanup(fn: () => void): void {
    cleanupCallbacks.delete(fn);
}

/**
 * Return the AbortSignal that will fire when a termination signal is received.
 * Returns `null` if {@link installSignalHandlers} has not been called yet.
 * @returns {AbortSignal | null}
 */
export function getShutdownSignal(): AbortSignal | null {
    return controller ? controller.signal : null;
}

/**
 * Install process-level signal handlers for SIGINT, SIGTERM, and (on Windows)
 * SIGBREAK.  Safe to call more than once – subsequent calls are no-ops.
 *
 * Creates an internal AbortController whose signal is available via
 * {@link getShutdownSignal}.
 */
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

/**
 * Remove the process-level signal handlers and reset internal state.
 * Primarily useful for testing so handlers don't leak between runs.
 */
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

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function onSignal() {
    if (shuttingDown) return; // prevent re-entrant cleanup
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

// ---------------------------------------------------------------------------
// Helpers for temp-root lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a cleanup callback that removes a directory tree, and register it.
 * Returns the dispose function.
 *
 * @param {string} dirPath  Absolute path to the temp directory.
 * @returns {() => void} dispose – call to unregister (e.g. in a finally block
 *                        after the directory has already been cleaned up).
 */
export function registerTempRoot(dirPath: string): () => void {
    const fn = function () {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (_e) { /* best effort */ }
    };
    return registerCleanup(fn);
}

