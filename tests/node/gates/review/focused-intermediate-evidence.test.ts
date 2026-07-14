import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../src/gates/review/focused-intermediate-evidence';

const TASK_ID = 'T-979-4';
const TEST_PATH = 'tests/node/gates/review/focused-intermediate-evidence.test.ts';

function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFixture(): { repoRoot: string; bundleRoot: string; reviewsRoot: string; eventsRoot: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-evidence-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    return { repoRoot, bundleRoot, reviewsRoot, eventsRoot };
}

function appendEvidence(options: {
    bundleRoot: string;
    reviewsRoot: string;
    taskId?: string;
    command?: string;
    status?: 'PASSED' | 'FAILED';
    mutateOutput?: boolean;
    artifactTaskId?: string;
    omitEventExitCode?: boolean;
    omitEventOutputArtifactPath?: boolean;
    preflightPath?: string;
    preflightSha256?: string;
    coverageContractSha256?: string;
    eventPreflightSha256?: string;
}): void {
    const taskId = options.taskId ?? TASK_ID;
    const command = options.command
        ?? `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`;
    const suffix = crypto.randomBytes(4).toString('hex');
    const outputPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.log`);
    const artifactPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.json`);
    const status = options.status ?? 'PASSED';
    fs.writeFileSync(outputPath, 'focused validation passed\n', 'utf8');
    const outputSha256 = sha256(outputPath);
    const outputSize = fs.statSync(outputPath).size;
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: options.artifactTaskId ?? taskId,
        command_source: 'targeted-test',
        command,
        status,
        exit_code: status === 'PASSED' ? 0 : 1,
        output_artifact: outputPath,
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize,
        ...(options.preflightPath ? { preflight_path: options.preflightPath } : {}),
        ...(options.preflightSha256 ? { preflight_sha256: options.preflightSha256 } : {}),
        ...(options.coverageContractSha256 ? { coverage_contract_sha256: options.coverageContractSha256 } : {})
    }), 'utf8');
    const eventDetails: Record<string, unknown> = {
        command_source: 'targeted-test',
        command,
        artifact_path: artifactPath,
        artifact_sha256: sha256(artifactPath),
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize
    };
    if (options.preflightPath) {
        eventDetails.preflight_path = options.preflightPath;
    }
    if (options.preflightSha256) {
        eventDetails.preflight_sha256 = options.eventPreflightSha256 ?? options.preflightSha256;
    }
    if (options.coverageContractSha256) {
        eventDetails.coverage_contract_sha256 = options.coverageContractSha256;
    }
    if (!options.omitEventOutputArtifactPath) {
        eventDetails.output_artifact_path = outputPath;
    }
    if (!options.omitEventExitCode) {
        eventDetails.exit_code = status === 'PASSED' ? 0 : 1;
    }
    appendTaskEvent(options.bundleRoot, taskId, 'INTERMEDIATE_COMMAND_RUN', status, 'Focused command.', eventDetails);
    if (options.mutateOutput) {
        fs.appendFileSync(outputPath, 'tampered\n', 'utf8');
    }
}

describe('task-owned focused intermediate evidence', () => {
    it('selects only current-cycle, PASS, scope-matched evidence with bounded metadata', () => {
        const fixture = makeFixture();
        try {
            appendEvidence(fixture);
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.truncated, true);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.entries.every((entry) => entry.status === 'PASSED' && entry.exit_code === 0));
            assert.ok(selection.entries.every((entry) => entry.focused_test_paths.includes(TEST_PATH)));
            assert.ok(selection.warnings.some((warning) => warning.includes('stale or foreign task/cycle binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects failed, foreign, scope-mismatched, and tampered evidence with actionable warnings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, status: 'FAILED' });
            appendEvidence({ ...fixture, omitEventExitCode: true });
            appendEvidence({ ...fixture, omitEventOutputArtifactPath: true });
            appendEvidence({ ...fixture, artifactTaskId: 'T-FOREIGN' });
            appendEvidence({
                ...fixture,
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/other.test.ts'
            });
            appendEvidence({ ...fixture, mutateOutput: true });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 6);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a gate-owned PASSED command')));
            assert.ok(selection.warnings.some((warning) => warning.includes('binding is inconsistent')));
            assert.ok(selection.warnings.some((warning) => warning.includes('outside the current review scope')));
            assert.ok(selection.warnings.some((warning) => warning.includes('size or sha256')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('requires focused evidence to match expected preflight and coverage bindings when provided', () => {
        const fixture = makeFixture();
        const preflightPath = path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/');
        const preflightSha256 = 'a'.repeat(64);
        const coverageContractSha256 = 'b'.repeat(64);
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256: 'c'.repeat(64),
                coverageContractSha256
            });
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256,
                coverageContractSha256
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256,
                expectedCoverageContractSha256: coverageContractSha256,
                maxEntries: 2
            });

            assert.equal(selection.entries.length, 1);
            assert.equal(selection.entries[0].preflight_sha256, preflightSha256);
            assert.equal(selection.entries[0].coverage_contract_sha256, coverageContractSha256);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('does not match the current review context')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when event and artifact scope bindings disagree', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'a'.repeat(64),
                eventPreflightSha256: 'b'.repeat(64),
                coverageContractSha256: 'c'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('artifact and event preflight')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects malformed focused evidence hash bindings even without expected bindings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'not-a-sha256',
                coverageContractSha256: 'b'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a valid SHA-256 hex binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('does not bind surplus focused artifacts after the entry limit is reached', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, mutateOutput: true });
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 0);
            assert.equal(selection.truncated, true);
            assert.equal(selection.warnings.some((warning) => warning.includes('size or sha256')), false);
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when the task timeline exceeds bounded read limits', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence(fixture);

            const byteBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineBytes: 1
            });

            assert.equal(byteBoundSelection.entries.length, 0);
            assert.equal(byteBoundSelection.truncated, true);
            assert.ok(byteBoundSelection.warnings.some((warning) => warning.includes('byte read bound')));

            const eventBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineEvents: 1
            });

            assert.equal(eventBoundSelection.entries.length, 0);
            assert.equal(eventBoundSelection.truncated, true);
            assert.ok(eventBoundSelection.warnings.some((warning) => warning.includes('event read bound')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('caps intermediate candidate scanning even when more surplus evidence exists', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 8; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3,
                maxIntermediateCandidatesScanned: 4
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 4);
            assert.equal(selection.truncated, true);
            assert.ok(selection.warnings.some((warning) => warning.includes('surplus scan stopped after 4 intermediate candidates')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});
