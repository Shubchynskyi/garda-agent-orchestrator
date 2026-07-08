import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES,
    buildDefaultWorkflowConfig,
    isOptionalQualityCheckRuleExcludedForScope
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

const UNIVERSAL_QUALITY_RULE_EXPECTATIONS = Object.freeze([
    Object.freeze({
        id: 'code_simplification',
        promptPatterns: [/simplified/i, /behavior/i, /diagnostics/i],
        action: 'Simplify the changed code without weakening behavior, validation, or diagnostics.'
    }),
    Object.freeze({
        id: 'project_style_fit',
        promptPatterns: [/project style/i, /module boundaries/i, /helper patterns/i],
        action: 'Align the change with local project style, naming, boundaries, and helper patterns.'
    }),
    Object.freeze({
        id: 'unnecessary_abstraction',
        promptPatterns: [/abstractions/i, /duplication/i, /complexity/i],
        action: 'Remove abstractions that do not reduce real duplication, risk, or complexity.'
    }),
    Object.freeze({
        id: 'size_growth',
        promptPatterns: [/classes, functions, or files/i, /grew/i, /ownership/i],
        action: 'Extract or clarify touched code that grew enough to blur ownership.'
    }),
    Object.freeze({
        id: 'hardcoded_values_contracts',
        promptPatterns: [/literals, paths, statuses, or messages/i, /constants/i, /contracts/i],
        action: 'Move new literals, paths, statuses, or messages into shared contracts where appropriate.'
    }),
    Object.freeze({
        id: 'duplicated_logic_contracts',
        promptPatterns: [/duplicates logic/i, /validation/i, /one place/i],
        action: 'Remove duplicated logic, validation, or contract strings.'
    }),
    Object.freeze({
        id: 'test_verification_scope',
        promptPatterns: [/focused tests/i, /behavioral risk/i, /slow coverage/i],
        action: 'Adjust verification scope so behavioral risk is covered without unrelated slow tests.'
    })
]);

const UNIVERSAL_QUALITY_RULE_IDS = Object.freeze(
    UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id)
);

const OPS_SHELL_QUALITY_RULE_EXPECTATIONS = Object.freeze([
    Object.freeze({
        id: 'ops_shell_strict_error_handling',
        promptPatterns: [/strict shell behavior/i, /error propagation/i, /portability/i],
        action: 'Tighten strict shell behavior, error propagation, cleanup paths, and portability.'
    }),
    Object.freeze({
        id: 'ops_deploy_backup_idempotency',
        promptPatterns: [/idempotency/i, /dry-run or confirmation/i, /restore verification/i],
        action: 'Add idempotency, dry-run or confirmation semantics, and restore verification where needed.'
    }),
    Object.freeze({
        id: 'ops_secret_env_loading',
        promptPatterns: [/secret handling/i, /env-file loading safety/i, /shared helper/i],
        action: 'Reuse or extract shared environment-loading helpers and keep secrets out of logs.'
    })
]);

const OPS_SHELL_QUALITY_RULE_IDS = Object.freeze(
    OPS_SHELL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id)
);
const OPS_SHELL_QUALITY_RULE_ID_SET = new Set<string>(OPS_SHELL_QUALITY_RULE_IDS);

const MOVED_PROJECT_LOCAL_RULE_IDS = Object.freeze([
    'classifier_intent_edge_cases',
    'config_materialization_parity',
    'control_plane_action_safety',
    'artifact_evidence_binding',
    'gate_routing_self_regression'
]);

const CUSTOM_GARDA_RULE_IDS = Object.freeze([
    'custom_garda_classifier_intent_edge_cases',
    'custom_garda_config_materialization_parity',
    'custom_garda_control_plane_action_safety',
    'custom_garda_artifact_evidence_binding',
    'custom_garda_gate_routing_self_regression'
]);

function buildTestQualityRule(id: string): ReturnType<typeof buildDefaultWorkflowConfig>['optional_quality_checks']['rules'][number] {
    return {
        id,
        title: `Rule ${id}`,
        prompt: `Check ${id}.`,
        enabled: true
    };
}

function writeStaleMovedRuleWorkflowConfig(fixture: ReturnType<typeof createGateFixture>): void {
    const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.baseline_version = '2026-06-26.t843';
    config.optional_quality_checks.rules = [
        ...config.optional_quality_checks.rules,
        ...MOVED_PROJECT_LOCAL_RULE_IDS.map(buildTestQualityRule),
        ...CUSTOM_GARDA_RULE_IDS.map(buildTestQualityRule)
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function buildPassAnswers(): Array<Record<string, unknown>> {
    return buildPassAnswersForRuleIds(UNIVERSAL_QUALITY_RULE_IDS);
}

function buildPassAnswersForRuleIds(ruleIds: readonly string[]): Array<Record<string, unknown>> {
    return ruleIds.map((ruleId) => ({
        rule_id: ruleId,
        status: 'PASS',
        answer: `Checked ${ruleId} against the changed files.`,
        evidence_files: ['src/app.ts'],
        actions_taken: [`No action required for ${ruleId}.`]
    }));
}

function buildGenericActionRequiredAnswers(): Array<Record<string, unknown>> {
    const actionByRuleId = new Map<string, string>(
        UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => [rule.id, rule.action])
    );
    return buildPassAnswers().map((answer) => {
        const action = actionByRuleId.get(String(answer.rule_id));
        if (!action) {
            return answer;
        }
        return {
            ...answer,
            status: 'ACTION_REQUIRED',
            answer: `The ${answer.rule_id} check found a review-saving regression risk before expensive gates.`,
            evidence_files: [
                'src/gates/next-step/next-step-task-queue.ts',
                'tests/node/gates/next-step/next-step-task-queue.test.ts'
            ],
            actions_taken: [],
            actions_required: [action]
        };
    });
}

describe('quality-checklist gate', () => {
    it('ships enabled universal baseline prompts and excludes project-local rule classes', () => {
        const rulesById = new Map(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule]));

        for (const expectation of UNIVERSAL_QUALITY_RULE_EXPECTATIONS) {
            const rule = rulesById.get(expectation.id);
            assert.ok(rule, `Expected shipped optional quality rule '${expectation.id}'.`);
            assert.equal(rule.enabled, true);
            const searchableText = `${rule.title}\n${rule.prompt}`;
            for (const pattern of expectation.promptPatterns) {
                assert.match(searchableText, pattern, `Rule '${expectation.id}' should mention ${pattern}.`);
            }
        }
        const testOnlySkippedRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
            .filter((rule) => isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
            .map((rule) => rule.id)
            .sort();
        assert.deepEqual(testOnlySkippedRuleIds, [
            'code_simplification',
            'size_growth',
            'unnecessary_abstraction'
        ]);

        for (const ruleId of MOVED_PROJECT_LOCAL_RULE_IDS) {
            assert.equal(rulesById.has(ruleId), false, `Expected '${ruleId}' to be project-local, not shipped baseline.`);
        }
    });

    it('ships ops/shell baseline prompts as changed-file scoped rules', () => {
        const rulesById = new Map(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule]));

        assert.deepEqual(
            OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id),
            OPS_SHELL_QUALITY_RULE_IDS
        );
        for (const expectation of OPS_SHELL_QUALITY_RULE_EXPECTATIONS) {
            const rule = rulesById.get(expectation.id);
            assert.ok(rule, `Expected shipped optional quality rule '${expectation.id}'.`);
            assert.equal(rule.enabled, true);
            assert.ok(
                Array.isArray(rule.included_changed_file_regexes) && rule.included_changed_file_regexes.length > 0,
                `Rule '${expectation.id}' should be active only for matching ops/shell changed files.`
            );
            assert.equal(rule.excluded_scope_categories, undefined);
            const searchableText = `${rule.title}\n${rule.prompt}`;
            for (const pattern of expectation.promptPatterns) {
                assert.match(searchableText, pattern, `Rule '${expectation.id}' should mention ${pattern}.`);
            }
        }
    });

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
            assert.equal(artifact.answers.length, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.deepEqual(artifact.changed_file_evidence.changed_files, ['src/app.ts', 'src/feature.ts']);
            assert.equal(artifact.changed_file_evidence.scope_sha256, 'a'.repeat(64));
            assert.equal(artifact.changed_file_evidence.scope_content_sha256, 'b'.repeat(64));
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.skipped_by_scope_rule_count, OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.ok(artifact.workflow_config_sha256);
            assert.ok(artifact.preflight_sha256);
            assert.deepEqual(artifact.violations, []);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => rule.scope_applicability === 'skipped_by_scope')
                    .map((rule) => rule.id)
                    .sort(),
                [...OPS_SHELL_QUALITY_RULE_IDS].sort()
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('activates ops/shell rules for shell, deploy, backup, and restore changed files', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-shell-active-rules' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'config-only',
                metrics: {
                    changed_lines_total: 12,
                    scope_sha256: 'e'.repeat(64),
                    scope_content_sha256: 'f'.repeat(64)
                },
                changed_files: [
                    'scripts/deploy.sh',
                    'ops/backup.ps1',
                    '.github/workflows/restore-release.yml'
                ]
            });
            const expectedActiveRuleIds = [
                ...UNIVERSAL_QUALITY_RULE_IDS,
                ...OPS_SHELL_QUALITY_RULE_IDS
            ];

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(expectedActiveRuleIds)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'config-only');
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, expectedActiveRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 0);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                    .map((rule) => [rule.id, rule.scope_applicability]),
                OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'active'])
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('activates ops/shell rules for non-shell ops script extensions', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-script-extension-rules' });
        try {
            const expectedActiveRuleIds = [
                ...UNIVERSAL_QUALITY_RULE_IDS,
                ...OPS_SHELL_QUALITY_RULE_IDS
            ];
            const changedFiles = [
                'scripts/deploy-release.mjs',
                'tools/backup-runner.ts',
                'ops/restore_snapshot.py'
            ];

            for (const changedFile of changedFiles) {
                const preflightPath = writeGateFixturePreflight(fixture, {
                    scope_category: 'mixed',
                    metrics: {
                        changed_lines_total: 8,
                        scope_sha256: '1'.repeat(64),
                        scope_content_sha256: '2'.repeat(64)
                    },
                    changed_files: [changedFile]
                });

                const artifact = buildQualityChecklistArtifact({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflightPath,
                    answers: buildPassAnswersForRuleIds(expectedActiveRuleIds)
                });

                assert.equal(artifact.status, 'PASS', changedFile);
                assert.equal(artifact.active_rule_count, expectedActiveRuleIds.length, changedFile);
                assert.equal(artifact.skipped_by_scope_rule_count, 0, changedFile);
                assert.deepEqual(
                    artifact.rules
                        .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                        .map((rule) => [rule.id, rule.scope_applicability]),
                    OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'active']),
                    changedFile
                );
                assert.deepEqual(artifact.violations, [], changedFile);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('does not activate ops/shell rules for ordinary filenames containing ops as a substring', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-substring-not-active' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'mixed',
                metrics: {
                    changed_lines_total: 6,
                    scope_sha256: '3'.repeat(64),
                    scope_content_sha256: '4'.repeat(64)
                },
                changed_files: ['src/components/props.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(UNIVERSAL_QUALITY_RULE_IDS)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.active_rule_count, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.skipped_by_scope_rule_count, OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                    .map((rule) => [rule.id, rule.scope_applicability]),
                OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'skipped_by_scope'])
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('accepts only active rule answers for test-only scope and records skipped rules', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-test-only-active-rules' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                metrics: {
                    changed_lines_total: 4,
                    scope_sha256: 'a'.repeat(64),
                    scope_content_sha256: 'b'.repeat(64)
                },
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
                .filter((rule) => !isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
                .filter((rule) => !OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                .map((rule) => rule.id);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(activeRuleIds)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'test-only');
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, activeRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 3 + OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.answers.length, activeRuleIds.length);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => rule.scope_applicability === 'skipped_by_scope')
                    .map((rule) => rule.id)
                    .sort(),
                [
                    'code_simplification',
                    ...OPS_SHELL_QUALITY_RULE_IDS,
                    'size_growth',
                    'unnecessary_abstraction'
                ].sort()
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects answers for rules skipped by test-only scope', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-test-only-skipped-answer' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
                .filter((rule) => !isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
                .filter((rule) => !OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                .map((rule) => rule.id);
            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: [
                    ...buildPassAnswersForRuleIds(activeRuleIds),
                    {
                        rule_id: 'code_simplification',
                        status: 'PASS',
                        answer: 'This rule is intentionally skipped for pure test changes.'
                    }
                ]
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.ok(artifact.violations.some((violation) => (
                violation.includes("Answer references quality-check rule 'code_simplification' skipped for the current preflight scope")
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('applies custom rule test-only opt-out through quality-checklist behavior', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-custom-test-only-skip' });
        try {
            const customRule = {
                ...buildTestQualityRule('custom_test_only_skip'),
                excluded_scope_categories: ['test-only']
            };
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.rules = [
                ...config.optional_quality_checks.rules,
                customRule
            ];
            fs.writeFileSync(
                path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json'),
                JSON.stringify(config, null, 2) + '\n',
                'utf8'
            );
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = config.optional_quality_checks.rules
                .filter((rule) => !isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
                .filter((rule) => !OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                .map((rule) => rule.id);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(activeRuleIds)
            });
            const skippedCustomRule = artifact.rules.find((rule) => rule.id === customRule.id);

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'test-only');
            assert.equal(artifact.enabled_rule_count, config.optional_quality_checks.rules.length);
            assert.equal(artifact.active_rule_count, activeRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 4 + OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.equal(skippedCustomRule?.scope_applicability, 'skipped_by_scope');
            assert.deepEqual(skippedCustomRule?.excluded_scope_categories, ['test-only']);
            assert.match(skippedCustomRule?.scope_skip_reason || '', /test-only/u);
            assert.equal(artifact.answers.some((answer) => answer.rule_id === customRule.id), false);
            assert.deepEqual(artifact.violations, []);

            const rejectedArtifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: [
                    ...buildPassAnswersForRuleIds(activeRuleIds),
                    {
                        rule_id: customRule.id,
                        status: 'PASS',
                        answer: 'This custom rule is intentionally skipped for pure test changes.'
                    }
                ]
            });

            assert.equal(rejectedArtifact.status, 'CONFIG_ERROR');
            assert.ok(rejectedArtifact.violations.some((violation) => (
                violation.includes("Answer references quality-check rule 'custom_test_only_skip' skipped for the current preflight scope")
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('records ACTION_REQUIRED for every universal baseline rule before review setup', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-derived-actions' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                metrics: {
                    changed_lines_total: 42,
                    scope_sha256: 'c'.repeat(64),
                    scope_content_sha256: 'd'.repeat(64)
                },
                changed_files: [
                    'src/gates/next-step/next-step-task-queue.ts',
                    'src/gates/next-step/next-step-pre-review-routing.ts',
                    'src/gates/review-cycle/review-cycle-guard.ts',
                    'tests/node/gates/next-step/next-step-task-queue.test.ts',
                    'tests/node/gates/next-step/next-step-quality-checklist-routing.test.ts',
                    'tests/node/gates/review-cycle/review-cycle-guard.test.ts'
                ]
            });

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildGenericActionRequiredAnswers()),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            assert.ok(result.outputLines.includes(`ActionsRequiredCount: ${UNIVERSAL_QUALITY_RULE_EXPECTATIONS.length}`));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            const requiredRuleIds = artifact.answers
                .filter((answer: { status: string }) => answer.status === 'ACTION_REQUIRED')
                .map((answer: { rule_id: string }) => answer.rule_id)
                .sort();

            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.deepEqual(
                requiredRuleIds,
                UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id).sort()
            );
            assert.equal(artifact.actions_required.length, UNIVERSAL_QUALITY_RULE_EXPECTATIONS.length);
            assert.ok(artifact.changed_file_evidence.changed_files.some((filePath: string) => filePath.startsWith('tests/')));
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

    it('reads answers from a repo-local JSON file', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-path' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.answers.length, UNIVERSAL_QUALITY_RULE_IDS.length);
        } finally {
            fixture.cleanup();
        }
    });

    it('reads answers from stdin text without logging the raw JSON', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-stdin' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const rawAnswers = JSON.stringify(buildPassAnswers());

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersStdin: true,
                answersStdinText: rawAnswers,
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
            assert.equal(result.outputLines.join('\n').includes(rawAnswers), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('reports invalid JSON from answers-path without echoing file contents', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-invalid-answers-path' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'invalid-quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '[{"rule_id":"code_simplification",', 'utf8');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            }), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /AnswersPath must be valid JSON/u);
                assert.equal(error.message.includes('code_simplification'), false);
                return true;
            });
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects answers-path symlinks that resolve outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-path-realpath-escape' });
        const outsideDir = path.join(path.dirname(fixture.repoRoot), `${fixture.taskId}-outside`);
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            fs.mkdirSync(outsideDir, { recursive: true });
            const outsideAnswersPath = path.join(outsideDir, 'quality-answers.json');
            fs.writeFileSync(outsideAnswersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            const symlinkPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'outside-quality-answers.json');
            fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
            try {
                fs.symlinkSync(outsideAnswersPath, symlinkPath, 'file');
            } catch (error: unknown) {
                if (process.platform === 'win32') {
                    return;
                }
                throw error;
            }

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath: symlinkPath,
                emitMetrics: false
            }), /AnswersPath must resolve inside repo root/u);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
            fixture.cleanup();
        }
    });

    it('rejects ambiguous answers input modes instead of applying precedence', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-ambiguous' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                answersPath,
                emitMetrics: false
            }), /pass only one of --answers-json, --answers-path, or --answers-stdin/u);
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

    it('explains stale materialized rule-set mismatch before unknown moved-rule answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-moved-rules' });
        try {
            writeStaleMovedRuleWorkflowConfig(fixture);
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = [
                ...buildPassAnswers(),
                ...MOVED_PROJECT_LOCAL_RULE_IDS.map((ruleId) => ({
                    rule_id: ruleId,
                    status: 'PASS',
                    answer: `Answered moved rule ${ruleId}.`
                }))
            ];

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_CONFIG_ERROR'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            const diagnostic = String(artifact.violations[0] || '');

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.match(diagnostic, /baseline_version '2026-06-26\.t843' differs from shipped '2026-07-08\.t934'/u);
            assert.match(diagnostic, /classifier_intent_edge_cases/u);
            assert.match(diagnostic, /custom_garda_classifier_intent_edge_cases/u);
            assert.match(diagnostic, /Canonical enabled quality-check rule ids/u);
            assert.match(diagnostic, /deprecated or moved ids are not accepted/u);
            assert.equal(artifact.rules.some((rule: { id: string }) => rule.id === 'classifier_intent_edge_cases'), false);
            assert.equal(artifact.rules.some((rule: { id: string }) => rule.id === 'custom_garda_classifier_intent_edge_cases'), true);
            assert.ok(artifact.violations.some((violation: string) => (
                violation.includes("Answer references unknown or disabled quality-check rule 'classifier_intent_edge_cases'")
            )));
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
