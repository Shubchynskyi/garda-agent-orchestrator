import test from 'node:test';
import assert from 'node:assert/strict';

import { stringSha256, fileSha256 } from '../../../src/gate-runtime/hash';
import { toStringArray, countTextChars, matchAnyRegex } from '../../../src/gate-runtime/text-utils';

// --- stringSha256 ---

test('stringSha256 returns null for null/undefined', () => {
    assert.equal(stringSha256(null as unknown as string), null);
    assert.equal(stringSha256(undefined), null);
});

test('stringSha256 returns correct hash for empty string', () => {
    // SHA-256 of "" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert.equal(stringSha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('stringSha256 returns correct hash for "hello"', () => {
    // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    assert.equal(stringSha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('stringSha256 returns lowercase hex', () => {
    const hash: string | null = stringSha256('test');
    assert.match(hash!, /^[0-9a-f]{64}$/);
});

// --- fileSha256 ---

test('fileSha256 returns null for null/missing path', () => {
    assert.equal(fileSha256(null as unknown as string), null);
    assert.equal(fileSha256(''), null);
    assert.equal(fileSha256('/nonexistent/path/file.txt'), null);
});

// --- toStringArray ---

test('toStringArray returns empty array for null/undefined', () => {
    assert.deepEqual(toStringArray(null), []);
    assert.deepEqual(toStringArray(undefined), []);
});

test('toStringArray wraps non-empty string', () => {
    assert.deepEqual(toStringArray('hello'), ['hello']);
});

test('toStringArray returns empty for empty/whitespace string', () => {
    assert.deepEqual(toStringArray(''), []);
    assert.deepEqual(toStringArray('   '), []);
});

test('toStringArray filters null/empty from arrays', () => {
    assert.deepEqual(toStringArray(['a', null, '', '  ', 'b']), ['a', 'b']);
});

test('toStringArray trims values when option set', () => {
    assert.deepEqual(toStringArray(['  a  ', '  b  '], { trimValues: true }), ['a', 'b']);
});

test('toStringArray converts numbers to strings', () => {
    assert.deepEqual(toStringArray(42), ['42']);
});

// --- countTextChars ---

test('countTextChars returns 0 for empty input', () => {
    assert.equal(countTextChars([]), 0);
    assert.equal(countTextChars(null), 0);
});

test('countTextChars sums line lengths plus newline separators', () => {
    // "abc" + "de" = 3 + 2 chars + 1 newline = 6
    assert.equal(countTextChars(['abc', 'de']), 6);
});

test('countTextChars single line has no newline', () => {
    assert.equal(countTextChars(['hello']), 5);
});

// --- matchAnyRegex ---

test('matchAnyRegex returns true on match', () => {
    assert.equal(matchAnyRegex('src/main.py', ['src/.*\\.py$']), true);
});

test('matchAnyRegex returns false on no match', () => {
    assert.equal(matchAnyRegex('README.md', ['src/.*\\.py$']), false);
});

test('matchAnyRegex skips empty patterns', () => {
    assert.equal(matchAnyRegex('test.js', ['', null as unknown as string, 'test']), true);
});

test('matchAnyRegex throws on invalid regex by default', () => {
    assert.throws(() => matchAnyRegex('test', ['[invalid']), /Invalid regular expression/);
});

test('matchAnyRegex skips invalid regex when option set', () => {
    assert.equal(matchAnyRegex('test', ['[invalid', 'test'], { skipInvalidRegex: true }), true);
});

test('matchAnyRegex supports case-insensitive matching when requested', () => {
    assert.equal(matchAnyRegex('src/SecurityConfig.java', ['securityconfig\\.java$'], { caseInsensitive: true }), true);
});
