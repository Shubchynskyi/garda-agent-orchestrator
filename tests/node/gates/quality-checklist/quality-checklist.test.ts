import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    buildDefaultWorkflowConfig
} from '../../../../src/core/workflow-config';
import {
    buildQualityChecklistArtifact
} from '../../../../src/gates/quality-checklist';
import {
    runQualityChecklistCommand
} from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import {
    createGateFixture,
    writeGateFixturePreflight
} from '../../gate-fixtures';

function buildPassAnswers(): Array<Record<string, unknown>> {
    return DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => ({
        rule_id: rule.id,
        status: 'PASS',
        answer: `Checked ${rule.id} against the changed files.`,
        evidence_files: ['src/app.ts'],
        actions_taken: [`No action required for ${rule.id}.`]
    }));
}

describe('quality-checklist gate', () => {
    it('builds PASS artifact with configured rules and changed-file evidence', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-pass' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                metrics: {
                    changed_lines_total: 4,
                    scope_sha256: 'a'.repeat(64),
                    scope_content_sha256: 'b'.repeat(64)
                },
                changed_files: ['src/app.ts', 'src/feature.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.outcome, 'PASS');
            assert.equal(artifact.checklist_id, 'optional_quality_checks');
            assert.equal(artifact.rules.length, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.answers.length, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.deepEqual(artifact.changed_file_evidence.changed_files, ['src/app.ts', 'src/feature.ts']);
            assert.equal(artifact.changed_file_evidence.scope_sha256, 'a'.repeat(64));
            assert.equal(artifact.changed_file_evidence.scope_content_sha256, 'b'.repeat(64));
            assert.ok(artifact.workflow_config_sha256);
            assert.ok(artifact.preflight_sha256);
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('records ACTION_REQUIRED output and returns gate failure', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-action' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers[0] = {
                ...answers[0],
                status: 'ACTION_REQUIRED',
                answer: 'The change needs a smaller helper before closeout.',
                actions_required: ['Extract repeated status formatting before completion.']
            };

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            assert.ok(result.outputLines.includes('ActionsRequiredCount: 1'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifactPath = artifactPathLine.replace('QualityChecklistArtifactPath: ', '');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.deepEqual(artifact.actions_required, ['Extract repeated status formatting before completion.']);

            const timelinePath = path.join(fixture.orchestratorRoot, 'runtime', 'task-events', `${fixture.taskId}.jsonl`);
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.ok(timeline.includes('"event_type":"QUALITY_CHECKLIST_RECORDED"'));
            assert.ok(timeline.includes('"artifact_hash"'));
        } finally {
            fixture.cleanup();
        }
    });

    it('promotes top-level actions_required to ACTION_REQUIRED', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-top-level-action' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                actionRequired: 'Document the remaining follow-up before closeout.',
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.deepEqual(artifact.actions_required, ['Document the remaining follow-up before closeout.']);
        } finally {
            fixture.cleanup();
        }
    });

    it('records WARN output and returns gate success', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-warn' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers[0] = {
                ...answers[0],
                status: 'WARN',
                answer: 'The change is acceptable, but follow-up simplification may be useful.'
            };

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_WARNED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'WARN');
            assert.equal(artifact.outcome, 'WARN');
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit artifact paths outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-artifact-escape' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const outsideArtifactPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-outside.json');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                artifactPath: outsideArtifactPath,
                emitMetrics: false
            }), /Path must stay inside repo root/);
            assert.equal(fs.existsSync(outsideArtifactPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit metrics paths outside the repo root before writing the artifact', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-metrics-escape' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const artifactPath = path.join(fixture.repoRoot, 'custom-quality-checklist.json');
            const outsideMetricsPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-metrics.jsonl');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                artifactPath,
                metricsPath: outsideMetricsPath
            }), /Path must stay inside repo root/);
            assert.equal(fs.existsSync(artifactPath), false);
            assert.equal(fs.existsSync(outsideMetricsPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit preflight paths outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-preflight-escape' });
        const outsidePreflightPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-preflight.json');
        try {
            fs.writeFileSync(outsidePreflightPath, JSON.stringify({
                task_id: fixture.taskId,
                changed_files: ['src/app.ts']
            }, null, 2) + '\n', 'utf8');

            assert.throws(() => buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath: outsidePreflightPath,
                answers: buildPassAnswers()
            }), /Path must stay inside repo root/);
        } finally {
            fs.rmSync(outsidePreflightPath, { force: true });
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when preflight task_id does not match the checklist task', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-preflight-mismatch' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                task_id: 'T-quality-other',
                changed_files: ['src/app.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => (
                violation.includes("Preflight artifact task_id 'T-quality-other' does not match quality-checklist task_id")
            )));
            assert.deepEqual(artifact.changed_file_evidence.changed_files, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('skips cleanly when optional quality checks are disabled', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-disabled' });
        try {
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.enabled = false;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: '[]',
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_SKIPPED_DISABLED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'SKIPPED_DISABLED');
            assert.deepEqual(artifact.answers, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when an enabled rule is missing an answer', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-config-error' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers().slice(1)
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('Missing answer')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when configured rules have duplicate ids', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-duplicate-rule' });
        try {
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.rules.push({
                ...config.optional_quality_checks.rules[0],
                title: 'Duplicate code simplification'
            });
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('duplicate quality-check rule id')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when an enabled rule has duplicate answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-duplicate-answer' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers.push({ ...answers[0] });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('Duplicate answer')));
        } finally {
            fixture.cleanup();
        }
    });
});
