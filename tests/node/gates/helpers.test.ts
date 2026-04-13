import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendMetricsEvent,
    computeProtectedSnapshotDigest,
    getProtectedControlPlaneRoots,
    joinOrchestratorPath,
    normalizePath,
    toPosix,
    resolveTaskId,
    parseBool,
    stringSha256,
    normalizeRootPrefixes,
    testPathPrefix,
    toStringArray
} from '../../../src/gates/helpers';

describe('gates/helpers', () => {
    describe('normalizePath', () => {
        it('converts backslashes to forward slashes', () => {
            assert.equal(normalizePath('foo\\bar\\baz'), 'foo/bar/baz');
        });
        it('strips leading ./', () => {
            assert.equal(normalizePath('./src/index.ts'), 'src/index.ts');
        });
        it('trims whitespace', () => {
            assert.equal(normalizePath('  foo/bar  '), 'foo/bar');
        });
        it('returns empty for null', () => {
            assert.equal(normalizePath(null), '');
        });
        it('collapses duplicate slashes', () => {
            assert.equal(normalizePath('foo//bar///baz'), 'foo/bar/baz');
        });
    });

    describe('toPosix', () => {
        it('converts backslashes', () => {
            assert.equal(toPosix('C:\\Users\\test'), 'C:/Users/test');
        });
        it('returns empty for null', () => {
            assert.equal(toPosix(null), '');
        });
    });

    describe('resolveTaskId', () => {
        it('returns explicit task ID when provided', () => {
            assert.equal(resolveTaskId('T-001', ''), 'T-001');
        });
        it('extracts from output path hint when explicit is empty', () => {
            assert.equal(resolveTaskId('', '/reviews/T-001-preflight.json'), 'T-001');
        });
        it('returns null when both are empty', () => {
            assert.equal(resolveTaskId('', ''), null);
        });
        it('strips -preflight suffix from hint', () => {
            assert.equal(resolveTaskId('', 'task-42-preflight.json'), 'task-42');
        });
    });

    describe('parseBool', () => {
        it('parses true values', () => {
            assert.equal(parseBool('true'), true);
            assert.equal(parseBool('yes'), true);
            assert.equal(parseBool('1'), true);
            assert.equal(parseBool('да'), true);
            assert.equal(parseBool(true), true);
        });
        it('parses false values', () => {
            assert.equal(parseBool('false'), false);
            assert.equal(parseBool('no'), false);
            assert.equal(parseBool('0'), false);
            assert.equal(parseBool('нет'), false);
            assert.equal(parseBool(false), false);
        });
        it('returns default for null', () => {
            assert.equal(parseBool(null, true), true);
            assert.equal(parseBool(null, false), false);
        });
    });

    describe('stringSha256', () => {
        it('returns a 64-char lowercase hex string', () => {
            const hash = stringSha256('hello');
            assert.equal(hash!.length, 64);
            assert.match(hash!, /^[a-f0-9]{64}$/);
        });
        it('returns null for null input', () => {
            assert.equal(stringSha256(null), null);
        });
        it('produces deterministic output', () => {
            assert.equal(stringSha256('test'), stringSha256('test'));
        });
    });

    describe('normalizeRootPrefixes', () => {
        it('ensures trailing slash and sorts', () => {
            const result = normalizeRootPrefixes(['src', 'app/', 'frontend']);
            assert.deepEqual(result, ['app/', 'frontend/', 'src/']);
        });
        it('deduplicates', () => {
            const result = normalizeRootPrefixes(['src/', 'src/']);
            assert.deepEqual(result, ['src/']);
        });
        it('handles empty input', () => {
            assert.deepEqual(normalizeRootPrefixes([]), []);
        });
    });

    describe('testPathPrefix', () => {
        it('matches prefix case-insensitively', () => {
            assert.equal(testPathPrefix('src/foo.ts', ['src/']), true);
            assert.equal(testPathPrefix('SRC/foo.ts', ['src/']), true);
        });
        it('matches exact file paths without requiring a trailing slash', () => {
            assert.equal(testPathPrefix('AGENTS.md', ['AGENTS.md']), true);
            assert.equal(testPathPrefix('.github/agents/orchestrator.md', ['.github/agents/orchestrator.md']), true);
        });
        it('returns false when no prefix matches', () => {
            assert.equal(testPathPrefix('lib/foo.ts', ['src/']), false);
        });
    });

    describe('computeProtectedSnapshotDigest', () => {
        it('is deterministic regardless of object key order', () => {
            const left = computeProtectedSnapshotDigest({
                'garda-agent-orchestrator/src/cli/main.ts': 'aaa',
                'AGENTS.md': 'bbb'
            });
            const right = computeProtectedSnapshotDigest({
                'AGENTS.md': 'bbb',
                'garda-agent-orchestrator/src/cli/main.ts': 'aaa'
            });
            assert.equal(left, right);
        });

        it('changes when any protected file hash changes', () => {
            const before = computeProtectedSnapshotDigest({
                'AGENTS.md': 'aaa'
            });
            const after = computeProtectedSnapshotDigest({
                'AGENTS.md': 'bbb'
            });
            assert.notEqual(before, after);
        });
    });

    describe('getProtectedControlPlaneRoots', () => {
        it('includes root-level agent control-plane files and bridges', () => {
            const roots = getProtectedControlPlaneRoots('D:/repo');
            assert.ok(roots.includes('AGENTS.md'));
            assert.ok(roots.includes('.agents/workflows/start-task.md'));
            assert.ok(roots.includes('.github/agents/orchestrator.md'));
            assert.ok(roots.includes('.github/agents/reviewer.md'));
        });
    });

    describe('joinOrchestratorPath', () => {
        it('prefers a nested deployed legacy bundle over the source checkout root', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-join-path-'));
            try {
                fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# source manifest', 'utf8');
                fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
                fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');

                const legacyBundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
                fs.mkdirSync(path.join(legacyBundleRoot, 'bin'), { recursive: true });
                fs.mkdirSync(path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
                fs.writeFileSync(path.join(legacyBundleRoot, 'MANIFEST.md'), '# bundle manifest', 'utf8');
                fs.writeFileSync(path.join(legacyBundleRoot, 'VERSION'), '2.4.3', 'utf8');
                fs.writeFileSync(path.join(legacyBundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
                fs.writeFileSync(path.join(legacyBundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node', 'utf8');
                fs.writeFileSync(path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules', 'utf8');

                assert.equal(
                    joinOrchestratorPath(tmpDir, 'live/docs/agent-rules/00-core.md'),
                    path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules', '00-core.md')
                );
                assert.equal(
                    joinOrchestratorPath(tmpDir, 'garda-agent-orchestrator/live/docs/agent-rules/00-core.md'),
                    path.join(legacyBundleRoot, 'live', 'docs', 'agent-rules', '00-core.md')
                );
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });

    describe('toStringArray', () => {
        it('converts a single string', () => {
            assert.deepEqual(toStringArray('hello'), ['hello']);
        });
        it('converts an array', () => {
            assert.deepEqual(toStringArray(['a', 'b', null, '']), ['a', 'b']);
        });
        it('returns empty for null', () => {
            assert.deepEqual(toStringArray(null), []);
        });
        it('trims when option set', () => {
            assert.deepEqual(toStringArray(['  a  ', '  b  '], { trimValues: true }), ['a', 'b']);
        });
    });

    describe('appendMetricsEvent', () => {
        it('records a gate event plus toxin metrics for the resolved bundle runtime', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-metrics-helper-'));
            try {
                const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
                const runtimeRoot = path.join(bundleRoot, 'runtime');
                fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
                fs.mkdirSync(path.join(runtimeRoot, 'reviews'), { recursive: true });
                fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0', 'utf8');
                fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
                fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '', 'utf8');
                fs.writeFileSync(path.join(runtimeRoot, 'reviews', 'big.json'), 'x'.repeat(600 * 1024), 'utf8');
                const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');

                appendMetricsEvent(metricsPath, { event_type: 'gate_check', status: 'PASSED' }, true, tmpDir);

                const lines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
                const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

                assert.equal(lines.length, 6);
                assert.equal(parsed[0].event_type, 'gate_check');
                assert.ok(parsed.some((entry) => entry.metric_type === 'disk_artifact_growth'));
                assert.ok(parsed.some((entry) => entry.metric_type === 'noisy_outputs'));
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
