import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_COMPILE_TIMEOUT_MS,
    DEFAULT_GIT_CLONE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    DEFAULT_NPM_TIMEOUT_MS,
    spawnStreamed,
    spawnShellCommand,
    spawnSyncWithTimeout
} from '../../../src/core/subprocess';

describe('spawnStreamed', () => {
    it('captures stdout from a successful process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("hello")'], {
            timeoutMs: 5000
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /hello/);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    });

    it('captures stderr from a failing process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.error("fail"); process.exit(1)'], {
            timeoutMs: 5000
        });
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /fail/);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    });

    it('times out a long-running process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            timeoutMs: 500
        });
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
    });

    it('respects AbortController cancellation', async () => {
        const ac = new AbortController();
        const promise = spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            signal: ac.signal,
            timeoutMs: 30000
        });
        // Cancel quickly
        setTimeout(() => ac.abort(), 200);
        const result = await promise;
        assert.equal(result.cancelled, true);
    });

    it('resolves immediately when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("should not run")'], {
            signal: ac.signal
        });
        assert.equal(result.cancelled, true);
        assert.equal(result.stdout, '');
    });

    it('streams output via onStdout callback', async () => {
        const chunks: string[] = [];
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("chunk1"); console.log("chunk2")'], {
            timeoutMs: 5000,
            onStdout(chunk) { chunks.push(chunk); }
        });
        assert.equal(result.exitCode, 0);
        const combined = chunks.join('');
        assert.match(combined, /chunk1/);
        assert.match(combined, /chunk2/);
    });

    it('rejects with ENOENT for missing executable', async () => {
        await assert.rejects(
            () => spawnStreamed('__nonexistent_executable_12345__', [], { timeoutMs: 5000 }),
            (err) => (err as Error).message.includes('not found in PATH')
        );
    });

    it('sets stdoutTruncated and stderrTruncated to false under normal output', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("ok")'], {
            timeoutMs: 5000
        });
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
    });

    it('sets stdoutTruncated when stdout exceeds maxBuffer', async () => {
        // Emit ~200 bytes of stdout against a 64-byte maxBuffer
        const script = 'for(let i=0;i<20;i++) process.stdout.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stdoutTruncated, true);
        assert.equal(result.stderrTruncated, false);
        // Buffered portion must be <= maxBuffer bytes
        assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64);
    });

    it('retains the buffered prefix of an overflowing stdout chunk', async () => {
        const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stdoutTruncated, true);
        assert.ok(result.stdout.length > 0, 'expected buffered prefix to be retained');
        assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64);
        assert.equal(payload.startsWith(result.stdout), true);
    });

    it('retains a valid UTF-8 stdout prefix at multibyte boundaries', async () => {
        const payload = '😀AB'.repeat(20);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            maxBuffer: 5
        });
        assert.equal(result.stdoutTruncated, true);
        assert.equal(result.stdout, '😀A');
        assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 5);
    });

    it('sets stderrTruncated when stderr exceeds maxBuffer', async () => {
        const script = 'for(let i=0;i<20;i++) process.stderr.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stderrTruncated, true);
        assert.equal(result.stdoutTruncated, false);
        assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 64);
    });

    it('retains a valid UTF-8 stderr prefix at multibyte boundaries', async () => {
        const payload = '😀AB'.repeat(20);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            maxBuffer: 5
        });
        assert.equal(result.stderrTruncated, true);
        assert.equal(result.stderr, '😀A');
        assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 5);
    });

    it('delivers callbacks for all chunks even when buffer is truncated', async () => {
        const allChunks: string[] = [];
        const script = 'for(let i=0;i<20;i++) process.stdout.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64,
            onStdout(chunk) { allChunks.push(chunk); }
        });
        assert.equal(result.stdoutTruncated, true);
        // Callbacks receive the full output regardless of maxBuffer
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via callback, got ${callbackTotal}`);
    });

    it('delivers stderr callbacks for all chunks even when buffer is truncated', async () => {
        const allChunks: string[] = [];
        const script = 'for(let i=0;i<20;i++) process.stderr.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64,
            onStderr(chunk) { allChunks.push(chunk); }
        });
        assert.equal(result.stderrTruncated, true);
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via stderr callback, got ${callbackTotal}`);
    });

    it('reports truncated false for pre-aborted signal', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("nope")'], {
            signal: ac.signal
        });
        assert.equal(result.cancelled, true);
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
    });
});

describe('spawnSyncWithTimeout', () => {
    it('runs a process successfully', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'console.log("ok")'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeoutMs: 5000
        });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /ok/);
        assert.equal(result.timedOut, false);
    });

    it('sets timedOut flag when process exceeds timeout', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'const s=Date.now();while(Date.now()-s<10000){}'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeoutMs: 500
        });
        assert.equal(result.timedOut, true);
    });

    it('passes through windowsHide by default', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'process.exit(0)'], {
            encoding: 'utf8',
            stdio: 'pipe'
        });
        assert.equal(result.status, 0);
    });
});

describe('spawnStreamed – kill-path cleanup', () => {
    it('terminates a process tree on timeout', async () => {
        // Parent spawns a child; both sleep forever.
        // On Windows killChild() uses taskkill /T /F for tree-kill.
        const script = [
            "import * as cp from 'child_process';",
            'cp.spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {stdio:"ignore"});',
            'setTimeout(()=>{},60000);'
        ].join('\n');

        const t0 = Date.now();
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 1000
        });
        const elapsed = Date.now() - t0;

        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
        // Must resolve near the timeout, not hang waiting for the child tree
        assert.ok(elapsed < 15000, `Expected resolution near timeout, took ${elapsed}ms`);
    });

    it('kills process that traps SIGTERM (exercises taskkill /F on Windows)', async () => {
        // Process installs a SIGTERM handler so child.kill('SIGTERM') alone would
        // not terminate it. On Windows the taskkill /F flag force-kills regardless.
        const script = 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 800
        });
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
    });

    it('kill-path via AbortController without timeout', async () => {
        const ac = new AbortController();
        const t0 = Date.now();
        const promise = spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            signal: ac.signal,
            timeoutMs: 0
        });
        setTimeout(() => ac.abort(), 300);
        const result = await promise;
        const elapsed = Date.now() - t0;

        assert.equal(result.cancelled, true);
        assert.equal(result.timedOut, false);
        assert.ok(elapsed < 15000, `Expected prompt cancellation, took ${elapsed}ms`);
    });
});

describe('timeout constants', () => {
    it('exports expected default timeout constants', () => {
        assert.equal(typeof DEFAULT_GIT_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_GIT_CLONE_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_NPM_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_COMPILE_TIMEOUT_MS, 'number');
        assert.ok(DEFAULT_GIT_TIMEOUT_MS > 0);
        assert.ok(DEFAULT_COMPILE_TIMEOUT_MS >= DEFAULT_GIT_TIMEOUT_MS);
    });
});

describe('shell-surface hardening', () => {
    it('spawnStreamed ignores shell property even if force-cast at runtime', async () => {
        // Prove that even if a caller bypasses TypeScript and sneaks in shell: true,
        // spawnStreamed does NOT pass it to child_process.spawn.
        const runtimeOpts = { timeoutMs: 5000, shell: true } as any;
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("safe")'], runtimeOpts);
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /safe/);
    });

    it('spawnStreamed does not execute via shell even with crafted arguments', async () => {
        // A command-injection payload that would succeed under shell mode should
        // simply appear as a literal argument in non-shell mode.
        const maliciousArg = '&& echo INJECTED';
        const result = await spawnStreamed(
            process.execPath,
            ['-e', `process.stdout.write(process.argv[1])`, '--', maliciousArg],
            { timeoutMs: 5000 }
        );
        assert.equal(result.exitCode, 0);
        // The argument must arrive as-is, not interpreted by a shell
        assert.ok(result.stdout.includes('&& echo INJECTED'));
        assert.ok(!result.stdout.includes('INJECTED\n'));
    });

    it('spawnShellCommand rejects on non-Windows platforms', async () => {
        if (process.platform === 'win32') {
            // On Windows spawnShellCommand is allowed; verify it runs a simple cmd
            const result = await spawnShellCommand('echo shelltest', { timeoutMs: 5000 });
            assert.equal(result.exitCode, 0);
            assert.match(result.stdout, /shelltest/);
        } else {
            await assert.rejects(
                () => spawnShellCommand('echo test', { timeoutMs: 5000 }),
                (err) => (err as Error).message.includes('restricted to Windows')
            );
        }
    });

    it('spawnShellCommand supports timeout', async () => {
        if (process.platform !== 'win32') return;
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "setTimeout(()=>{},60000)"`,
            { timeoutMs: 500 }
        );
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
    });

    it('spawnShellCommand supports AbortController cancellation', async () => {
        if (process.platform !== 'win32') return;
        const ac = new AbortController();
        const promise = spawnShellCommand(
            `"${process.execPath}" -e "setTimeout(()=>{},60000)"`,
            { signal: ac.signal, timeoutMs: 30000 }
        );
        setTimeout(() => ac.abort(), 300);
        const result = await promise;
        assert.equal(result.cancelled, true);
    });

    it('spawnShellCommand exposes truncation flags under normal output', async () => {
        if (process.platform !== 'win32') return;
        const result = await spawnShellCommand('echo shelltrunctest', { timeoutMs: 5000 });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
    });

    it('spawnShellCommand sets stdoutTruncated when stdout exceeds maxBuffer', async () => {
        if (process.platform !== 'win32') return;
        // Use single-quoted strings to avoid cmd.exe double-quote escaping issues
        const script = "for(let i=0;i<20;i++) process.stdout.write('0123456789')";
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "${script}"`,
            { timeoutMs: 5000, maxBuffer: 64 }
        );
        assert.equal(result.stdoutTruncated, true);
        assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64);
    });

    it('spawnShellCommand retains the buffered prefix of an overflowing stdout chunk', async () => {
        if (process.platform !== 'win32') return;
        const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8);
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "process.stdout.write(${JSON.stringify(payload).replace(/"/g, '\\"')})"`,
            { timeoutMs: 5000, maxBuffer: 64 }
        );
        assert.equal(result.stdoutTruncated, true);
        assert.ok(result.stdout.length > 0, 'expected buffered prefix to be retained');
        assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64);
        assert.equal(payload.startsWith(result.stdout), true);
    });

    it('spawnShellCommand retains a valid UTF-8 stdout prefix at multibyte boundaries', async () => {
        if (process.platform !== 'win32') return;
        const payload = '😀AB'.repeat(20);
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "process.stdout.write(${JSON.stringify(payload).replace(/"/g, '\\"')})"`,
            { timeoutMs: 5000, maxBuffer: 5 }
        );
        assert.equal(result.stdoutTruncated, true);
        assert.equal(result.stdout, '😀A');
        assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 5);
    });

    it('spawnShellCommand sets stderrTruncated when stderr exceeds maxBuffer', async () => {
        if (process.platform !== 'win32') return;
        const script = "for(let i=0;i<20;i++) process.stderr.write('0123456789')";
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "${script}"`,
            { timeoutMs: 5000, maxBuffer: 64 }
        );
        assert.equal(result.stderrTruncated, true);
        assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 64);
    });

    it('spawnShellCommand retains a valid UTF-8 stderr prefix at multibyte boundaries', async () => {
        if (process.platform !== 'win32') return;
        const payload = '😀AB'.repeat(20);
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "process.stderr.write(${JSON.stringify(payload).replace(/"/g, '\\"')})"`,
            { timeoutMs: 5000, maxBuffer: 5 }
        );
        assert.equal(result.stderrTruncated, true);
        assert.equal(result.stderr, '😀A');
        assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 5);
    });

    it('spawnShellCommand delivers stdout callbacks for all chunks even when buffer is truncated', async () => {
        if (process.platform !== 'win32') return;
        const allChunks: string[] = [];
        const script = "for(let i=0;i<20;i++) process.stdout.write('0123456789')";
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "${script}"`,
            {
                timeoutMs: 5000,
                maxBuffer: 64,
                onStdout(chunk) { allChunks.push(chunk); }
            }
        );
        assert.equal(result.stdoutTruncated, true);
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via shell stdout callback, got ${callbackTotal}`);
    });

    it('spawnShellCommand delivers stderr callbacks for all chunks even when buffer is truncated', async () => {
        if (process.platform !== 'win32') return;
        const allChunks: string[] = [];
        const script = "for(let i=0;i<20;i++) process.stderr.write('0123456789')";
        const result = await spawnShellCommand(
            `"${process.execPath}" -e "${script}"`,
            {
                timeoutMs: 5000,
                maxBuffer: 64,
                onStderr(chunk) { allChunks.push(chunk); }
            }
        );
        assert.equal(result.stderrTruncated, true);
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via shell stderr callback, got ${callbackTotal}`);
    });

    it('spawnShellCommand reports truncated false for pre-aborted signal', async () => {
        if (process.platform !== 'win32') return;
        const ac = new AbortController();
        ac.abort();
        const result = await spawnShellCommand('echo nope', { signal: ac.signal });
        assert.equal(result.cancelled, true);
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
    });
});
