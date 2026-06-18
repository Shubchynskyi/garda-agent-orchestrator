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
        'ORDINARY_DOC_PATHS_PENDING',
        'DOC_IMPACT_MISSING'
    ];

    for (const id of requiredIds) {
        const result = explainFailure(id);
        assert.equal(result.found, true, `Expected to find remediation for ID: ${id}`);
        assert.ok(result.entry!.remediation.length > 0, `Expected non-empty remediation for: ${id}`);
    }
});

test('explainFailure renders ordinary doc paths pending remediation', () => {
    const result = explainFailure('ORDINARY_DOC_PATHS_PENDING');
    const output = formatExplainResult(result);

    assert.equal(result.found, true);
    assert.equal(result.failureId, 'ORDINARY_DOC_PATHS_PENDING');
    assert.ok(output.includes('ExplainFailure: ORDINARY_DOC_PATHS_PENDING'));
    assert.ok(output.includes('--ordinary-doc-paths'));
    assert.ok(output.includes('ordinary document paths'));
    assert.ok(output.includes('auditable planning/changelog doc exceptions'));
    assert.ok(output.includes('not a global ignore list'));
});

test('explainFailure renders skills prompt pending remediation as optional but mandatory to ask', () => {
    const result = explainFailure('SKILLS_PROMPT_PENDING');
    const output = formatExplainResult(result);

    assert.equal(result.found, true);
    assert.equal(result.failureId, 'SKILLS_PROMPT_PENDING');
    assert.ok(output.includes('optional specialist-skills yes/no question'));
    assert.ok(output.includes('Installing extra skills is optional'));
    assert.ok(output.includes('A no answer is allowed'));
    assert.ok(output.includes('--skills-prompted yes'));
    assert.ok(output.includes('false/no means the question is still incomplete'));
});

test('explainFailure renders executable project memory remediation command shape', () => {
    const result = explainFailure('PROJECT_MEMORY_PENDING');
    const output = formatExplainResult(result);

    assert.equal(result.found, true);
    assert.equal(result.failureId, 'PROJECT_MEMORY_PENDING');
    assert.ok(output.includes('Initialize or refresh Garda project memory.'));
    assert.ok(output.includes('--active-agent-files'));
    assert.ok(output.includes('--project-rules-updated'));
    assert.ok(output.includes('--skills-prompted'));
    assert.ok(output.includes('--ordinary-doc-paths'));
    assert.ok(!output.includes("'garda agent-init' to seed"));
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
    assert.ok(output.includes('configured compile/build/type-check command'));
    assert.ok(output.includes('gate compile-gate --preflight-path'));
    assert.ok(output.includes('<task-id>-preflight.json'));
    assert.doesNotMatch(output, /npm run build/u);
    assert.doesNotMatch(output, /--commands-path/u);
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
    assert.equal(output.includes('--start-banner "<repo-owned-banner>"'), false);
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
