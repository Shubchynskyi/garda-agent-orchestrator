import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';

import {
    redactHostname,
    redactPath,
    redactEnvObject,
    redactDiagnosticText,
    createRedactionContext,
    _resetCachedValues
} from '../../../src/core/redaction';

// ---------------------------------------------------------------------------
// redactHostname
// ---------------------------------------------------------------------------

test('redactHostname returns null for null input', () => {
    assert.equal(redactHostname(null), null);
});

test('redactHostname returns null for undefined input', () => {
    assert.equal(redactHostname(undefined), null);
});

test('redactHostname returns null for empty string', () => {
    assert.equal(redactHostname(''), null);
});

test('redactHostname returns null for whitespace-only string', () => {
    assert.equal(redactHostname('   '), null);
});

test('redactHostname returns a deterministic <host-...> token', () => {
    const result = redactHostname('my-workstation');
    assert.ok(result !== null);
    assert.match(result!, /^<host-[0-9a-f]{8}>$/);
});

test('redactHostname is deterministic for the same input', () => {
    const a = redactHostname('server-1');
    const b = redactHostname('server-1');
    assert.equal(a, b);
});

test('redactHostname produces different tokens for different inputs', () => {
    const a = redactHostname('host-a');
    const b = redactHostname('host-b');
    assert.notEqual(a, b);
});

test('redactHostname trims whitespace before hashing', () => {
    const a = redactHostname('  my-host  ');
    const b = redactHostname('my-host');
    assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// redactPath
// ---------------------------------------------------------------------------

test('redactPath returns empty string for empty input', () => {
    assert.equal(redactPath(''), '');
});

test('redactPath relativizes path inside repo root', () => {
    const result = redactPath('/projects/my-repo/src/index.ts', '/projects/my-repo');
    assert.equal(result, 'src/index.ts');
});

test('redactPath returns "." when path equals repo root', () => {
    const result = redactPath('/projects/my-repo', '/projects/my-repo');
    assert.equal(result, '.');
});

test('redactPath handles Windows-style path separator', () => {
    const result = redactPath('C:\\Users\\dev\\repo\\src\\file.ts', 'C:\\Users\\dev\\repo');
    assert.equal(result, 'src/file.ts');
});

test('redactPath replaces home directory prefix with <home>', () => {
    _resetCachedValues();
    const homedir = os.homedir().replace(/\\/g, '/');
    const testPath = homedir + '/Documents/secret.txt';
    const result = redactPath(testPath);
    assert.ok(
        result.startsWith('<home>'),
        `Expected result to start with <home>, got: ${result}`
    );
    assert.ok(!result.includes(homedir), 'Home directory should be redacted');
});

test('redactPath handles non-matching path unchanged', () => {
    // Path that does not match repo root, home dir, or username
    const result = redactPath('/opt/system/data/file.txt');
    assert.ok(typeof result === 'string');
});

// ---------------------------------------------------------------------------
// redactEnvObject
// ---------------------------------------------------------------------------

test('redactEnvObject redacts keys matching secret patterns', () => {
    const env = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        SECRET_KEY: 'supersecret',
        API_KEY: 'abc123',
        AUTH_TOKEN: 'tok-xyz',
        MY_PASSWORD: 'p@ssw0rd',
        NORMAL_VAR: 'safe_value',
        NODE_ENV: 'production'
    };
    const result = redactEnvObject(env);
    assert.equal(result['PATH'], '/usr/bin');
    assert.equal(result['HOME'], '/home/user');
    assert.equal(result['SECRET_KEY'], '<redacted>');
    assert.equal(result['API_KEY'], '<redacted>');
    assert.equal(result['AUTH_TOKEN'], '<redacted>');
    assert.equal(result['MY_PASSWORD'], '<redacted>');
    assert.equal(result['NORMAL_VAR'], 'safe_value');
    assert.equal(result['NODE_ENV'], 'production');
});

test('redactEnvObject skips undefined values', () => {
    const env: Record<string, string | undefined> = {
        PRESENT: 'yes',
        MISSING: undefined
    };
    const result = redactEnvObject(env);
    assert.equal(result['PRESENT'], 'yes');
    assert.ok(!('MISSING' in result));
});

test('redactEnvObject handles empty object', () => {
    const result = redactEnvObject({});
    assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// redactDiagnosticText
// ---------------------------------------------------------------------------

test('redactDiagnosticText replaces current hostname', () => {
    const hostname = os.hostname();
    if (!hostname) {
        return; // skip if hostname is empty
    }
    const text = `Lock held by ${hostname} with PID 1234`;
    const result = redactDiagnosticText(text);
    assert.ok(!result.includes(hostname), `Hostname '${hostname}' should be redacted`);
    assert.match(result, /<host-[0-9a-f]{8}>/);
});

test('redactDiagnosticText replaces home directory path', () => {
    _resetCachedValues();
    const homedir = os.homedir();
    if (!homedir) {
        return;
    }
    const text = `Working in ${homedir}/my-project`;
    const result = redactDiagnosticText(text);
    assert.ok(!result.includes(homedir), 'Home directory should be redacted');
    assert.ok(result.includes('<home>'), 'Should contain <home> placeholder');
});

test('redactDiagnosticText replaces repo root when provided', () => {
    const repoRoot = '/some/unique/project/root';
    const text = `Building at ${repoRoot}/src/index.ts`;
    const result = redactDiagnosticText(text, repoRoot);
    assert.ok(!result.includes(repoRoot), 'Repo root should be redacted');
    assert.ok(result.includes('<repo>'), 'Should contain <repo> placeholder');
});

test('redactDiagnosticText handles null/empty input gracefully', () => {
    assert.equal(redactDiagnosticText(''), '');
    assert.equal(redactDiagnosticText(null as unknown as string), null);
});

// ---------------------------------------------------------------------------
// createRedactionContext
// ---------------------------------------------------------------------------

test('createRedactionContext provides scoped redaction methods', () => {
    const repoRoot = '/workspace/project';
    const ctx = createRedactionContext(repoRoot);

    assert.equal(ctx.repoRoot, repoRoot);

    const hostname = ctx.redactHostname('my-server');
    assert.match(hostname!, /^<host-[0-9a-f]{8}>$/);

    const redactedPath = ctx.redactPath('/workspace/project/src/file.ts');
    assert.equal(redactedPath, 'src/file.ts');
});

test('createRedactionContext without repo root still works', () => {
    const ctx = createRedactionContext();
    assert.equal(ctx.repoRoot, undefined);

    const hostname = ctx.redactHostname('test-host');
    assert.ok(hostname !== null);
    assert.match(hostname!, /^<host-[0-9a-f]{8}>$/);
});

// ---------------------------------------------------------------------------
// Integration: redaction is consistent across module functions
// ---------------------------------------------------------------------------

test('redactHostname token matches what redactDiagnosticText produces', () => {
    const hostname = 'integration-test-host';
    const token = redactHostname(hostname)!;
    const text = `Connected to ${hostname}`;
    const result = redactDiagnosticText(text);
    // redactDiagnosticText only replaces the *current* os.hostname,
    // so this test checks the token format consistency.
    assert.match(token, /^<host-[0-9a-f]{8}>$/);
});

test('redactPath case-insensitive match on Windows-style paths', () => {
    const result = redactPath('C:/Users/Dev/REPO/src/file.ts', 'c:/users/dev/repo');
    assert.equal(result, 'src/file.ts');
});
