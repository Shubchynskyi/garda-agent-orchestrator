import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildCommandTimeoutDiagnostics,
    classifyTimeoutPhase,
    classifySuspectedLayer,
    CommandPhaseTracker,
    formatCommandTimeoutDiagnosticsResult,
    getCommandTimeoutEvidence,
    getCommandTimeoutEvidenceViolations,
    resolveCommandTimeoutArtifactPath,
    type CommandPhaseRecord,
    type CommandTimeoutDiagnosticsArtifact
} from '../../../../src/gates/diagnostics/command-timeout-diagnostics';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cmd-timeout-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function scaffoldWorkspace(root: string, options: { sourceCheckout?: boolean } = {}): void {
    if (options.sourceCheckout) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    }
    const runtimeDir = path.join(root, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
}

function makeCompletedRecord(label: string, elapsedMs: number): CommandPhaseRecord {
    const start = Date.now() - elapsedMs;
    const end = Date.now();
    return makeCompletedRecordWithTiming(label, `run ${label}`, start, end);
}

function makeCompletedRecordWithTiming(label: string, commandText: string, start: number, end: number): CommandPhaseRecord {
    const elapsedMs = Math.max(0, end - start);
    return {
        command_label: label,
        command_text: commandText,
        start_time_utc: new Date(start).toISOString(),
        first_output_time_utc: new Date(start + 10).toISOString(),
        last_output_time_utc: new Date(end - 5).toISOString(),
        end_time_utc: new Date(end).toISOString(),
        elapsed_ms: elapsedMs,
        time_to_first_output_ms: 10,
        output_gap_ms: 5,
        timeout_phase: 'completed',
        timed_out: false,
        exit_code: 0,
        suspected_layer: 'unknown',
        diagnosis: `Command completed normally in ${elapsedMs}ms.`
    };
}

function makeTimedOutRecord(label: string, phase: 'awaiting_first_output' | 'output_stalled'): CommandPhaseRecord {
    const start = Date.now() - 30000;
    const end = Date.now();
    const hasFirstOutput = phase === 'output_stalled';
    return {
        command_label: label,
        command_text: `run ${label}`,
        start_time_utc: new Date(start).toISOString(),
        first_output_time_utc: hasFirstOutput ? new Date(start + 100).toISOString() : null,
        last_output_time_utc: hasFirstOutput ? new Date(start + 5000).toISOString() : null,
        end_time_utc: new Date(end).toISOString(),
        elapsed_ms: 30000,
        time_to_first_output_ms: hasFirstOutput ? 100 : null,
        output_gap_ms: hasFirstOutput ? 25000 : null,
        timeout_phase: phase,
        timed_out: true,
        exit_code: null,
        suspected_layer: hasFirstOutput ? 'provider_callback' : 'bridge',
        diagnosis: `Command timed out.`
    };
}

describe('gates/command-timeout-diagnostics', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        removeTempDir(tempDir);
    });

    describe('classifyTimeoutPhase', () => {
        it('returns pre_launch when start is null', () => {
            assert.equal(classifyTimeoutPhase(null, null, null, null, false), 'pre_launch');
        });

        it('returns launch_pending when end is null', () => {
            assert.equal(classifyTimeoutPhase(1000, null, null, null, false), 'launch_pending');
        });

        it('returns completed when not timed out', () => {
            assert.equal(classifyTimeoutPhase(1000, 1010, 1050, 1100, false), 'completed');
        });

        it('returns awaiting_first_output when timed out with no output', () => {
            assert.equal(classifyTimeoutPhase(1000, null, null, 31000, true), 'awaiting_first_output');
        });

        it('returns output_stalled when timed out after output', () => {
            assert.equal(classifyTimeoutPhase(1000, 1010, 5000, 31000, true), 'output_stalled');
        });
    });

    describe('classifySuspectedLayer', () => {
        it('returns unknown when not timed out', () => {
            assert.equal(classifySuspectedLayer(1000, 1010, 1050, 1100, false), 'unknown');
        });

        it('returns shell when start is null and timed out', () => {
            assert.equal(classifySuspectedLayer(null, null, null, null, true), 'shell');
        });

        it('returns bridge when no first output and timed out', () => {
            assert.equal(classifySuspectedLayer(1000, null, null, 31000, true), 'bridge');
        });

        it('returns provider_callback when output existed but stalled', () => {
            assert.equal(classifySuspectedLayer(1000, 1010, 5000, 31000, true), 'provider_callback');
        });
    });

    describe('CommandPhaseTracker', () => {
        it('produces a completed record for a normal lifecycle', () => {
            const tracker = new CommandPhaseTracker('test-cmd', 'echo hello');
            tracker.recordStart();
            tracker.recordOutput();
            tracker.recordOutput();
            tracker.recordEnd(0, false);

            const record = tracker.toRecord();
            assert.equal(record.command_label, 'test-cmd');
            assert.equal(record.command_text, 'echo hello');
            assert.equal(record.timeout_phase, 'completed');
            assert.equal(record.timed_out, false);
            assert.equal(record.exit_code, 0);
            assert.equal(record.suspected_layer, 'unknown');
            assert.ok(record.start_time_utc);
            assert.ok(record.first_output_time_utc);
            assert.ok(record.last_output_time_utc);
            assert.ok(record.end_time_utc);
            assert.ok(typeof record.elapsed_ms === 'number');
            assert.ok(typeof record.time_to_first_output_ms === 'number');
            assert.ok(record.diagnosis.includes('completed normally'));
        });

        it('produces an awaiting_first_output record for timeout with no output', () => {
            const tracker = new CommandPhaseTracker('stuck-cmd', 'hang');
            tracker.recordStart();
            tracker.recordEnd(null, true);

            const record = tracker.toRecord();
            assert.equal(record.timeout_phase, 'awaiting_first_output');
            assert.equal(record.timed_out, true);
            assert.equal(record.suspected_layer, 'bridge');
            assert.equal(record.first_output_time_utc, null);
            assert.ok(record.diagnosis.includes('without producing any output'));
        });

        it('produces an output_stalled record for timeout after partial output', () => {
            const tracker = new CommandPhaseTracker('stall-cmd', 'partial');
            tracker.recordStart();
            tracker.recordOutput();
            tracker.recordEnd(null, true);

            const record = tracker.toRecord();
            assert.equal(record.timeout_phase, 'output_stalled');
            assert.equal(record.timed_out, true);
            assert.equal(record.suspected_layer, 'provider_callback');
            assert.ok(record.first_output_time_utc);
            assert.ok(record.diagnosis.includes('output stalled'));
        });

        it('produces a pre_launch record when start was never called', () => {
            const tracker = new CommandPhaseTracker('never-started', 'noop');
            const record = tracker.toRecord();
            assert.equal(record.timeout_phase, 'pre_launch');
            assert.equal(record.start_time_utc, null);
            assert.ok(record.diagnosis.includes('never started'));
        });

        it('only records first output once', () => {
            const tracker = new CommandPhaseTracker('multi', 'multi');
            tracker.recordStart();
            tracker.recordFirstOutput();
            const firstTime = tracker.toRecord().first_output_time_utc;
            tracker.recordFirstOutput();
            assert.equal(tracker.toRecord().first_output_time_utc, firstTime);
        });
    });

    describe('buildCommandTimeoutDiagnostics', () => {
        it('produces PASS when all commands completed', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const commands = [
                makeCompletedRecord('build', 500),
                makeCompletedRecord('test', 1200)
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-900',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.schema_version, 1);
            assert.equal(artifact.event_source, 'command-timeout-diagnostics');
            assert.equal(artifact.task_id, 'T-900');
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
            assert.equal(artifact.commands.length, 2);
            assert.equal(artifact.violations.length, 0);
            assert.ok(artifact.summary.includes('2 commands tracked'));
            assert.ok(artifact.summary.includes('2 completed'));
        });

        it('produces FAIL when a command timed out', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const commands = [
                makeCompletedRecord('build', 500),
                makeTimedOutRecord('test', 'awaiting_first_output')
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-901',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.length > 0);
            assert.ok(artifact.violations[0].includes('timed out'));
            assert.ok(artifact.summary.includes('1 timed out'));
        });

        it('produces FAIL for pre_launch failure', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const commands: CommandPhaseRecord[] = [{
                command_label: 'broken',
                command_text: 'run broken',
                start_time_utc: null,
                first_output_time_utc: null,
                last_output_time_utc: null,
                end_time_utc: null,
                elapsed_ms: null,
                time_to_first_output_ms: null,
                output_gap_ms: null,
                timeout_phase: 'pre_launch',
                timed_out: false,
                exit_code: null,
                suspected_layer: 'shell',
                diagnosis: 'Command was never started.'
            }];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-902',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some(v => v.includes('never launched')));
        });

        it('produces PASS with empty commands', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-903',
                repoRoot: tempDir,
                commands: []
            });

            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
            assert.equal(artifact.commands.length, 0);
            assert.ok(artifact.summary.includes('0 commands tracked'));
        });

        it('sets provider when provided', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-904',
                repoRoot: tempDir,
                provider: 'Antigravity'
            });

            assert.equal(artifact.provider, 'Antigravity');
        });

        it('fails when build producer overlaps direct .node-build consumer in command records', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const base = Date.now() - 10_000;
            const commands = [
                makeCompletedRecordWithTiming(
                    'build-node-foundation',
                    'npm run build:node-foundation',
                    base,
                    base + 2_000
                ),
                makeCompletedRecordWithTiming(
                    'compiled-tests',
                    'node --test .node-build/tests/node/materialization/install.test.js',
                    base + 500,
                    base + 1_500
                )
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-905',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('validation chain')));
            assert.ok(artifact.summary.includes('1 validation-chain overlaps'));
        });

        it('passes when build producer and direct .node-build consumer stay sequential', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const base = Date.now() - 10_000;
            const commands = [
                makeCompletedRecordWithTiming(
                    'build-node-foundation',
                    'npm run build:node-foundation',
                    base,
                    base + 2_000
                ),
                makeCompletedRecordWithTiming(
                    'compiled-tests',
                    'node --test .node-build/tests/node/materialization/install.test.js',
                    base + 2_100,
                    base + 3_100
                )
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-906',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
            assert.ok(!artifact.violations.some((violation) => violation.includes('validation chain')));
            assert.ok(artifact.summary.includes('0 validation-chain overlaps'));
        });

        it('fails when npm test overlaps direct .node-build consumer in command records', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const base = Date.now() - 10_000;
            const commands = [
                makeCompletedRecordWithTiming(
                    'npm-test',
                    'npm test',
                    base,
                    base + 3_000
                ),
                makeCompletedRecordWithTiming(
                    'compiled-tests',
                    'node --test .node-build/tests/node/materialization/install.test.js',
                    base + 800,
                    base + 1_800
                )
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-907',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('validation chain')));
            assert.ok(artifact.summary.includes('1 validation-chain overlaps'));
        });

        it('fails for Windows producer-consumer overlap with npm.cmd and node.exe direct compiled tests', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const base = Date.now() - 10_000;
            const commands = [
                makeCompletedRecordWithTiming(
                    'build-node-foundation-windows',
                    'npm.cmd run build:node-foundation',
                    base,
                    base + 2_500
                ),
                makeCompletedRecordWithTiming(
                    'compiled-tests-windows',
                    'node.exe --test .node-build\\tests\\node\\materialization\\install.test.js',
                    base + 750,
                    base + 1_750
                )
            ];

            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-908',
                repoRoot: tempDir,
                commands
            });

            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('validation chain')));
            assert.ok(artifact.summary.includes('1 validation-chain overlaps'));
        });
    });

    describe('formatCommandTimeoutDiagnosticsResult', () => {
        it('formats PASS artifact', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-910',
                repoRoot: tempDir,
                commands: [makeCompletedRecord('build', 200)]
            });

            const lines = formatCommandTimeoutDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('COMMAND_TIMEOUT_DIAGNOSTICS_PASSED'));
            assert.ok(lines.some(l => l.includes('T-910')));
            assert.ok(lines.some(l => l.includes('Summary:')));
        });

        it('formats FAIL artifact with violations', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-911',
                repoRoot: tempDir,
                commands: [makeTimedOutRecord('test', 'output_stalled')]
            });

            const lines = formatCommandTimeoutDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('COMMAND_TIMEOUT_DIAGNOSTICS_FAILED'));
            assert.ok(lines.some(l => l.includes('Violations:')));
            assert.ok(lines.some(l => l.includes('SuspectedLayer:')));
        });
    });

    describe('resolveCommandTimeoutArtifactPath', () => {
        it('returns default path when no explicit path', () => {
            const result = resolveCommandTimeoutArtifactPath(tempDir, 'T-920');
            assert.ok(result.includes('T-920-command-timeout.json'));
        });

        it('resolves explicit path inside repo', () => {
            const result = resolveCommandTimeoutArtifactPath(tempDir, 'T-920', 'custom/artifact.json');
            assert.ok(result.includes('custom'));
            assert.ok(result.includes('artifact.json'));
        });
    });

    describe('getCommandTimeoutEvidence', () => {
        it('returns TASK_ID_MISSING when taskId is null', () => {
            const result = getCommandTimeoutEvidence(tempDir, null);
            assert.equal(result.evidence_status, 'TASK_ID_MISSING');
        });

        it('returns EVIDENCE_FILE_MISSING when artifact does not exist', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const result = getCommandTimeoutEvidence(tempDir, 'T-930');
            assert.equal(result.evidence_status, 'EVIDENCE_FILE_MISSING');
            assert.ok(result.violations.length > 0);
        });

        it('returns PASS when artifact is valid', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-931',
                repoRoot: tempDir,
                commands: [makeCompletedRecord('build', 100)]
            });

            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-931');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-931');
            assert.equal(result.evidence_status, 'PASS');
        });

        it('returns PASS_WITH_VIOLATIONS when artifact has violations', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-932',
                repoRoot: tempDir,
                commands: [makeTimedOutRecord('test', 'awaiting_first_output')]
            });

            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-932');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-932');
            assert.equal(result.evidence_status, 'PASS_WITH_VIOLATIONS');
            assert.ok(result.violations.length > 0);
        });

        it('returns EVIDENCE_TASK_MISMATCH when artifact has wrong task id', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-999',
                repoRoot: tempDir,
                commands: []
            });

            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-933');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-933');
            assert.equal(result.evidence_status, 'EVIDENCE_TASK_MISMATCH');
        });

        it('returns EVIDENCE_SOURCE_INVALID when event_source is wrong', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-934');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify({
                task_id: 'T-934',
                event_source: 'wrong-source',
                status: 'PASSED',
                outcome: 'PASS'
            }), 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-934');
            assert.equal(result.evidence_status, 'EVIDENCE_SOURCE_INVALID');
        });

        it('returns EVIDENCE_INVALID_JSON when artifact is not valid JSON', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-935');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, 'not json at all', 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-935');
            assert.equal(result.evidence_status, 'EVIDENCE_INVALID_JSON');
        });
    });

    describe('getCommandTimeoutEvidenceViolations', () => {
        it('returns task-id-missing message for missing task id', () => {
            const result = getCommandTimeoutEvidenceViolations({
                task_id: null,
                evidence_path: null,
                evidence_hash: null,
                evidence_status: 'TASK_ID_MISSING',
                provider: null,
                violations: []
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('task id is missing'));
        });

        it('returns empty for PASS with no violations', () => {
            const result = getCommandTimeoutEvidenceViolations({
                task_id: 'T-940',
                evidence_path: 'some/path',
                evidence_hash: 'abc123',
                evidence_status: 'PASS',
                provider: null,
                violations: []
            });
            assert.equal(result.length, 0);
        });
    });

    describe('timeline binding', () => {
        it('returns EVIDENCE_TIMELINE_UNBOUND when timeline exists but has no event', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-950',
                repoRoot: tempDir,
                commands: [makeCompletedRecord('build', 100)]
            });

            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-950');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

            const timelinePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(timelinePath, JSON.stringify({
                event_type: 'OTHER_EVENT',
                task_id: 'T-950'
            }) + '\n', 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-950', {
                artifactPath,
                timelinePath
            });
            assert.equal(result.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
        });

        it('passes timeline binding when event exists with matching hash', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const artifact = buildCommandTimeoutDiagnostics({
                taskId: 'T-951',
                repoRoot: tempDir,
                commands: [makeCompletedRecord('build', 100)]
            });

            const artifactPath = resolveCommandTimeoutArtifactPath(tempDir, 'T-951');
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

            const crypto = require('node:crypto');
            const artifactContent = fs.readFileSync(artifactPath);
            const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');

            const timelinePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(timelinePath, JSON.stringify({
                event_type: 'COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED',
                task_id: 'T-951',
                details: { artifact_hash: artifactHash }
            }) + '\n', 'utf8');

            const result = getCommandTimeoutEvidence(tempDir, 'T-951', {
                artifactPath,
                timelinePath
            });
            assert.equal(result.evidence_status, 'PASS');
        });
    });
});
