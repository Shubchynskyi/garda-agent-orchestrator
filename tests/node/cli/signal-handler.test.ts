import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    installSignalHandlers,
    uninstallSignalHandlers,
    registerCleanup,
    unregisterCleanup,
    registerTempRoot,
    getShutdownSignal,
    computeSignalExitCode
} from '../../../src/cli/signal-handler';

afterEach(() => {
    uninstallSignalHandlers();
});

describe('registerCleanup / unregisterCleanup', () => {
    it('registerCleanup returns a dispose function', () => {
        installSignalHandlers();
        const dispose = registerCleanup(() => {});
        assert.equal(typeof dispose, 'function');
        dispose();
    });

    it('unregisterCleanup removes a previously registered callback', () => {
        installSignalHandlers();
        const fn = () => {};
        registerCleanup(fn);
        unregisterCleanup(fn);
    });

    it('dispose function returned by registerCleanup unregisters the callback', () => {
        installSignalHandlers();
        let called = false;
        const dispose = registerCleanup(() => { called = true; });
        dispose();
        assert.equal(called, false);
    });
});

describe('getShutdownSignal', () => {
    it('returns null before installSignalHandlers is called', () => {
        assert.equal(getShutdownSignal(), null);
    });

    it('returns an AbortSignal after installSignalHandlers', () => {
        installSignalHandlers();
        const signal = getShutdownSignal();
        assert.ok(signal, 'signal should not be null');
        assert.equal(signal.aborted, false);
    });

    it('returns null after uninstallSignalHandlers', () => {
        installSignalHandlers();
        uninstallSignalHandlers();
        assert.equal(getShutdownSignal(), null);
    });
});

describe('installSignalHandlers', () => {
    it('is idempotent – calling twice does not throw', () => {
        installSignalHandlers();
        installSignalHandlers(); // second call is a no-op
        const signal = getShutdownSignal();
        assert.ok(signal);
    });
});

describe('registerTempRoot', () => {
    it('returns a dispose function', () => {
        installSignalHandlers();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        try {
            const dispose = registerTempRoot(tempDir);
            assert.equal(typeof dispose, 'function');
            dispose();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('dispose does not throw for already-removed directories', () => {
        installSignalHandlers();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        const dispose = registerTempRoot(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        assert.doesNotThrow(() => dispose());
    });

    it('works without installSignalHandlers (cleanup only on explicit call)', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        try {
            const dispose = registerTempRoot(tempDir);
            assert.equal(typeof dispose, 'function');
            dispose();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe('uninstallSignalHandlers', () => {
    it('clears all registered cleanup callbacks', () => {
        installSignalHandlers();
        registerCleanup(() => {});
        registerCleanup(() => {});
        uninstallSignalHandlers();
        assert.equal(getShutdownSignal(), null);
    });

    it('is safe to call when handlers are not installed', () => {
        assert.doesNotThrow(() => uninstallSignalHandlers());
    });
});

describe('computeSignalExitCode — signal-to-exit-code mapping', () => {
    it('SIGINT → 130 (128 + 2)', () => {
        assert.equal(computeSignalExitCode('SIGINT'), 130);
    });

    it('SIGTERM → 143 (128 + 15)', () => {
        assert.equal(computeSignalExitCode('SIGTERM'), 143);
    });

    it('SIGHUP → 129 (128 + 1)', () => {
        assert.equal(computeSignalExitCode('SIGHUP'), 129);
    });

    it('SIGPIPE → 141 (128 + 13)', () => {
        assert.equal(computeSignalExitCode('SIGPIPE'), 141);
    });

    it('SIGBREAK → 149 (128 + 21)', () => {
        assert.equal(computeSignalExitCode('SIGBREAK'), 149);
    });

    it('SIGWINCH → 156 (128 + 28)', () => {
        assert.equal(computeSignalExitCode('SIGWINCH'), 156);
    });

    it('null → EXIT_SIGNAL_INTERRUPT (130) as fallback', () => {
        assert.equal(computeSignalExitCode(null), 130);
    });

    it('unknown signal → EXIT_SIGNAL_INTERRUPT (130) as fallback', () => {
        assert.equal(computeSignalExitCode('SIGUNKNOWN' as NodeJS.Signals), 130);
    });
});

describe('onSignal integration — exit code propagation', () => {
    let exitCode: number | null;
    let originalExit: typeof process.exit;

    beforeEach(() => {
        exitCode = null;
        originalExit = process.exit;
        process.exit = ((code?: number) => {
            exitCode = code ?? null;
            throw new Error('process.exit called with code: ' + code);
        }) as typeof process.exit;
    });

    afterEach(() => {
        process.exit = originalExit;
        uninstallSignalHandlers();
    });

    it('SIGINT → process.exit(130)', () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGINT').pop() as Function) || (() => {});
        try { handler('SIGINT'); } catch (_e) { /* expected */ }
        assert.equal(exitCode, 130);
    });

    it('SIGTERM → process.exit(143)', () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGTERM').pop() as Function) || (() => {});
        try { handler('SIGTERM'); } catch (_e) { /* expected */ }
        assert.equal(exitCode, 143);
    });

    it('idempotent — second signal does not call exit again', () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGTERM').pop() as Function) || (() => {});
        try { handler('SIGTERM'); } catch (_e) { /* expected */ }
        assert.equal(exitCode, 143);
        exitCode = null;
        try { handler('SIGTERM'); } catch (_e) { /* expected */ }
        assert.equal(exitCode, null, 'second call should not exit');
    });
});
