import { describe, it, afterEach } from 'node:test';
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
    getShutdownSignal
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
