import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUi } from '../../../../src/cli/commands/ui-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator-test', version: '0.0.0-test' };

async function captureOutput(action: () => unknown | Promise<unknown>): Promise<string> {
    const captured: string[] = [];
    const originalLog = console.log;
    try {
        process.env.NO_COLOR = '1';
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        await action();
    } finally {
        console.log = originalLog;
        delete process.env.NO_COLOR;
    }
    return captured.join('\n');
}

test('handleUi prints no-dependency localhost server help', async () => {
    const text = await captureOutput(() => handleUi(['--help'], PACKAGE_JSON));

    assert.match(text, /garda ui/);
    assert.match(text, /127\.0\.0\.1/);
    assert.match(text, /read-only/i);
    assert.match(text, /--actions/);
    assert.match(text, /--idle-minutes/);
    assert.match(text, /--idle-warning-seconds/);
    assert.match(text, /--no-idle-shutdown/);
    assert.match(text, /allow-listed/i);
    assert.match(text, /Ctrl\+C/);
});

test('handleUi rejects invalid explicit port', async () => {
    await assert.rejects(
        () => captureOutput(() => handleUi(['--port', '0'], PACKAGE_JSON)),
        /--port must be an integer from 1 to 65535/
    );
});

test('handleUi rejects conflicting read-only and actions flags', async () => {
    await assert.rejects(
        () => captureOutput(() => handleUi(['--read-only', '--actions'], PACKAGE_JSON)),
        /--actions cannot be combined with --read-only/
    );
});

test('handleUi rejects invalid idle settings', async () => {
    await assert.rejects(
        () => captureOutput(() => handleUi(['--idle-minutes', '0'], PACKAGE_JSON)),
        /--idle-minutes must be a positive number/
    );
    await assert.rejects(
        () => captureOutput(() => handleUi(['--idle-warning-seconds', '-1'], PACKAGE_JSON)),
        /--idle-warning-seconds must be a positive number/
    );
});
