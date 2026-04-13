import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    explainFailure,
    formatExplainResult,
    listExplainIds
} from '../../../src/validators/explain';

// ── explainFailure ────────────────────────────────────────────────────────────

test('explainFailure returns found=true for known ID', () => {
    const result = explainFailure('BUNDLE_MISSING');
    assert.equal(result.found, true);
    assert.equal(result.failureId, 'BUNDLE_MISSING');
    assert.ok(result.entry !== null);
    assert.ok(result.entry!.title.length > 0);
    assert.ok(result.entry!.description.length > 0);
    assert.ok(result.entry!.remediation.length > 0);
    assert.deepEqual(result.suggestions, []);
});

test('explainFailure is case-insensitive', () => {
    const resultLower = explainFailure('bundle_missing');
    const resultMixed = explainFailure('Bundle-Missing');
    assert.equal(resultLower.found, true);
    assert.equal(resultMixed.found, true);
    assert.equal(resultLower.failureId, 'BUNDLE_MISSING');
});

test('explainFailure returns found=false for unknown ID', () => {
    const result = explainFailure('TOTALLY_UNKNOWN_XYZ');
    assert.equal(result.found, false);
    assert.equal(result.entry, null);
});

test('explainFailure returns suggestions for unknown ID with partial match', () => {
    const result = explainFailure('TIMELINE');
    assert.equal(result.found, false);
    // Should suggest IDs that include TIMELINE
    assert.ok(result.suggestions.length > 0);
});

test('explainFailure handles all required failure IDs', () => {
    const requiredIds = [
        'BUNDLE_MISSING',
        'INIT_ANSWERS_MISSING',
        'TASK_MODE_NOT_ENTERED',
        'RULE_PACK_NOT_LOADED',
        'PREFLIGHT_MISSING',
        'COMPILE_GATE_FAILED',
        'REVIEW_GATE_FAILED',
        'COMPLETION_GATE_FAILED',
        'TIMELINE_INCOMPLETE',
        'TIMELINE_INTEGRITY_FAILED',
        'DOC_IMPACT_MISSING'
    ];

    for (const id of requiredIds) {
        const result = explainFailure(id);
        assert.equal(result.found, true, `Expected to find remediation for ID: ${id}`);
        assert.ok(result.entry!.remediation.length > 0, `Expected non-empty remediation for: ${id}`);
    }
});

// ── listExplainIds ────────────────────────────────────────────────────────────

test('listExplainIds returns non-empty array of strings', () => {
    const ids = listExplainIds();
    assert.ok(Array.isArray(ids));
    assert.ok(ids.length > 0);
    for (const id of ids) {
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
        // All IDs should be upper-case with underscores only
        assert.match(id, /^[A-Z_0-9]+$/, `ID '${id}' does not match expected format`);
    }
});

test('listExplainIds has no duplicates', () => {
    const ids = listExplainIds();
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'Duplicate failure IDs found in database');
});

// ── formatExplainResult ───────────────────────────────────────────────────────

test('formatExplainResult renders title and remediation steps for found entry', () => {
    const result = explainFailure('COMPILE_GATE_FAILED');
    const output = formatExplainResult(result);

    assert.ok(output.includes('ExplainFailure: COMPILE_GATE_FAILED'));
    assert.ok(output.includes('Title:'));
    assert.ok(output.includes('Description:'));
    assert.ok(output.includes('Remediation steps:'));
    assert.ok(output.includes('1.'));
});

test('formatExplainResult renders not-found message with available IDs', () => {
    const result = explainFailure('DOES_NOT_EXIST_ZZZ');
    const output = formatExplainResult(result);

    assert.ok(output.includes('ExplainFailure: UNKNOWN_ID'));
    assert.ok(output.includes('Available failure IDs:'));
    assert.ok(output.includes('BUNDLE_MISSING'));
});

test('formatExplainResult numbered remediation steps start at 1', () => {
    const result = explainFailure('REVIEW_GATE_FAILED');
    const output = formatExplainResult(result);
    assert.ok(output.includes('  1.'));
});

test('formatExplainResult for TIMELINE_INCOMPLETE mentions gate commands', () => {
    const result = explainFailure('TIMELINE_INCOMPLETE');
    const output = formatExplainResult(result);
    assert.ok(output.includes('task-events-summary'));
});

test('formatExplainResult for TASK_MODE_NOT_ENTERED mentions enter-task-mode', () => {
    const result = explainFailure('TASK_MODE_NOT_ENTERED');
    const output = formatExplainResult(result);
    assert.ok(output.includes('enter-task-mode'));
});

// ── scanRuntimeForKnownFailures ───────────────────────────────────────────────

test('scanRuntimeForKnownFailures returns empty array for non-existent bundle', () => {
    const { scanRuntimeForKnownFailures } = require('../../../src/validators/explain');
    const result: string[] = scanRuntimeForKnownFailures('/tmp/non-existent-bundle-xyz');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
});

test('scanRuntimeForKnownFailures detects failed compile gate artifact', () => {
    const { scanRuntimeForKnownFailures } = require('../../../src/validators/explain');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-test-'));
    const reviewsDir = path.join(tmpDir, 'runtime', 'reviews');

    try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(reviewsDir, 'T-099-compile-gate.json'),
            JSON.stringify({ status: 'FAILED', outcome: 'FAIL', task_id: 'T-099' }),
            'utf8'
        );

        const result: string[] = scanRuntimeForKnownFailures(tmpDir);
        assert.ok(result.includes('COMPILE_GATE_FAILED'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
