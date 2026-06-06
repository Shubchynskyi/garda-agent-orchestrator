import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatDoctorResult,
    formatDoctorResultCompact,
    runDoctor
} from '../../../src/validators/doctor';
import { NODE_ENGINE_RANGE } from '../../../src/core/constants';
import { buildFakeDoctorResult, createDoctorWorkspace, DEFAULT_NEW_EVIDENCE } from './doctor-workspace-builder';
import { buildEventIntegrityHash } from '../../../src/gate-runtime/task-events';

// formatDoctorResult: verify + manifest output

test('formatDoctorResult includes verify and manifest output', () => {
    const fakeResult = buildFakeDoctorResult();
    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('TargetRoot:'));
    assert.ok(output.includes('SourceOfTruth: Claude'));
    assert.ok(output.includes('MANIFEST_VALIDATION_PASSED'));
    assert.ok(output.includes('Doctor:'));
});

test('formatDoctorResult shows PASS for clean doctor', () => {
    const fakeResult = buildFakeDoctorResult();
    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Doctor: PASSED'));
    assert.ok(output.includes('Next: Execute task T-001'));
});

test('formatDoctorResult does not default to T-001 when TASK.md has no executable active-queue tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-no-task-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-711 | 🟩 DONE | P2 | workflow | Done task | codex | 2026-06-05 | strict | done |',
                '| T-708 | 🟪 DECOMPOSED | P2 | refactor | Parent task | codex | 2026-06-05 | strict | use children |',
                '| T-721 | 🟥 BLOCKED | P0 | runtime | Blocked task | codex | 2026-06-05 | strict | blocked |',
                ''
            ].join('\n'),
            'utf8'
        );
        const fakeResult = buildFakeDoctorResult({ targetRoot: tmpDir });
        const output = formatDoctorResult(fakeResult);

        assert.ok(output.includes('Doctor: PASSED'));
        assert.ok(output.includes('Next: No executable tasks found in TASK.md Active Queue; add or reopen a task before starting task execution.'));
        assert.ok(!output.includes('Next: Execute task T-001'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


test('formatDoctorResult includes timeline completeness warnings', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        verifyResult: {
            passed: false,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: ['TASK.md missing.'],
                initAnswersContractViolations: [],
                versionContractViolations: [],
                reviewCapabilitiesContractViolations: [],
                pathsContractViolations: [],
                tokenEconomyContractViolations: [],
                outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [],
                skillsIndexConfigContractViolations: [],
                ruleFileViolations: [],
                templatePlaceholderViolations: [],
                commandsContractViolations: [],
                manifestContractViolations: [],
                coreRuleContractViolations: [],
                entrypointContractViolations: [],
                taskContractViolations: [],
                qwenSettingsViolations: [],
                skillsIndexContractViolations: [],
                skillPackContractViolations: [],
                gitignoreMissing: []
            },
            totalViolationCount: 1
        },
        timelineEvidence: [{
            task_id: 'T-004',
            timeline_path: '/tmp/test/runtime/task-events/T-004.jsonl',
            status: 'PASS',
            completeness_status: 'INCOMPLETE',
            events_missing: ['REVIEW_PHASE_STARTED', 'COMPLETION_GATE_PASSED'],
            code_changed: true,
            events_scanned: 5,
            integrity_event_count: 5,
            violations: []
        }],
        timelineWarnings: [
            'INCOMPLETE timeline: T-004.jsonl (REVIEW_PHASE_STARTED; COMPLETION_GATE_PASSED). Repair: resume T-004 with node bin/garda.js next-step "T-004" --repo-root "." and complete the missing lifecycle gates'
        ]
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Timeline Evidence'));
    assert.ok(output.includes('T-004: integrity=PASS, completeness=INCOMPLETE'));
    assert.ok(output.includes('Timeline Warnings'));
    assert.ok(output.includes('INCOMPLETE timeline: T-004.jsonl'));
    assert.ok(output.includes('Repair: resume T-004'));
    assert.ok(output.includes('REVIEW_PHASE_STARTED'));
    assert.ok(output.includes('Doctor: FAIL'));
});

test('runDoctor uses TASK.md status to classify active blocked incomplete timelines', () => {
    const workspace = createDoctorWorkspace({
        manifestContent: [
            '- MANIFEST.md',
            '- VERSION',
            '- package.json',
            '- bin/garda.js',
            '- live/docs/agent-rules/00-core.md',
            '- live/config/review-capabilities.json',
            '- live/config/paths.json',
            '- live/config/token-economy.json',
            '- live/config/output-filters.json',
            '- live/config/skill-packs.json',
            '- live/config/skills-index.json',
            '- live/config/skills-headlines.json',
            '- live/config/garda.config.json',
            '- runtime/init-answers.json'
        ].join('\n') + '\n'
    });
    try {
        fs.writeFileSync(
            path.join(workspace.tmpDir, 'TASK.md'),
            [
                '# TASK.md',
                '',
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                '| T-CLI-ART | 🟥 BLOCKED | P1 | runtime | Active blocker | codex | 2026-06-05 | strict | blocked_reason_code=EXTERNAL |',
                ''
            ].join('\n'),
            'utf8'
        );
        fs.writeFileSync(path.join(workspace.bundlePath, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(path.join(workspace.bundlePath, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.mkdirSync(path.join(workspace.bundlePath, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(workspace.bundlePath, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.mkdirSync(path.join(workspace.bundlePath, 'live', 'docs', 'agent-rules'), { recursive: true });
        fs.writeFileSync(path.join(workspace.bundlePath, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core\n', 'utf8');
        const configDir = path.join(workspace.bundlePath, 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        for (const name of [
            'review-capabilities.json',
            'paths.json',
            'token-economy.json',
            'output-filters.json',
            'skill-packs.json',
            'skills-index.json',
            'skills-headlines.json',
            'garda.config.json'
        ]) {
            fs.writeFileSync(path.join(configDir, name), '{}\n', 'utf8');
        }
        const runtimeDir = path.join(workspace.bundlePath, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(path.join(runtimeDir, 'init-answers.json'), JSON.stringify({ SourceOfTruth: 'Codex' }), 'utf8');

        const timelineEvent: Record<string, unknown> = {
            timestamp_utc: '2026-03-28T10:00:00.000Z',
            task_id: 'T-CLI-ART',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Task mode entered.',
            details: {},
            integrity: {
                schema_version: 1,
                task_sequence: 1,
                prev_event_sha256: null,
                event_sha256: ''
            }
        };
        (timelineEvent.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(timelineEvent);
        const timelinePath = path.join(runtimeDir, 'task-events', 'T-CLI-ART.jsonl');
        fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
        fs.writeFileSync(timelinePath, JSON.stringify(timelineEvent) + '\n', 'utf8');

        const result = runDoctor({
            targetRoot: workspace.tmpDir,
            sourceOfTruth: 'Codex',
            activeAgentFiles: []
        });

        assert.ok(result.timelineWarnings.some((warning) =>
            warning.includes('INCOMPLETE timeline: T-CLI-ART.jsonl')
            && warning.includes('Repair: resolve the active BLOCKED task state for T-CLI-ART in TASK.md')
        ));
    } finally {
        workspace.cleanup();
    }
});

test('formatDoctorResult prints failure summary before detailed evidence', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        verifyResult: {
            passed: false,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: ['TASK.md missing.'],
                initAnswersContractViolations: [],
                versionContractViolations: [],
                reviewCapabilitiesContractViolations: [],
                pathsContractViolations: [],
                tokenEconomyContractViolations: [],
                outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [],
                skillsIndexConfigContractViolations: [],
                ruleFileViolations: [],
                templatePlaceholderViolations: [],
                commandsContractViolations: [],
                manifestContractViolations: [],
                coreRuleContractViolations: [],
                entrypointContractViolations: [],
                taskContractViolations: [],
                qwenSettingsViolations: [],
                skillsIndexContractViolations: [],
                skillPackContractViolations: [],
                gitignoreMissing: []
            },
            totalViolationCount: 1
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Doctor Failure Summary'));
    assert.ok(output.includes('\x1b[31mFAIL\x1b[0m'));
    assert.ok(output.includes('Blockers:'));
    assert.ok(output.includes('First verify violation(s):'));
    assert.ok(output.includes('missingPaths: TASK.md missing.'));
    assert.ok(output.indexOf('Doctor Failure Summary') < output.indexOf('TargetRoot:'));
    assert.ok(output.includes('Detailed Evidence'));
});

test('formatDoctorResult highlights protected manifest drift with repair guidance', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        protectedManifestEvidence: {
            status: 'DRIFT' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
            manifest: null
        },
        protectedManifestAssessment: {
            code: 'BLOCKING_DRIFT' as const,
            severity: 'fail' as const,
            blocks: true,
            requires_refresh: true
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Protected Control-Plane Manifest is DRIFT with 1 changed protected file(s).'));
    assert.ok(output.includes('garda-agent-orchestrator/live/config/workflow-config.json'));
    assert.ok(output.includes('repair protected-manifest --target-root "." --confirm'));
    assert.ok(output.indexOf('Protected Control-Plane Manifest is DRIFT') < output.indexOf('Protected Control-Plane Manifest\n  Status: DRIFT'));
});

test('formatDoctorResult summarizes runtime compatibility failures before detailed runtime section', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: false,
            current_node_version: 'v18.0.0',
            required_range: '^22.13.0 || >=24.0.0',
            violations: ['Unable to parse engine range: ^22.13.0 || >=24.0.0']
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Runtime compatibility check failed for Node v18.0.0 against ^22.13.0 || >=24.0.0.'));
    assert.ok(output.includes('Inspect runtime compatibility diagnostics, then rerun doctor.'));
    assert.ok(output.indexOf('Runtime compatibility check failed for Node v18.0.0') < output.indexOf('Runtime Compatibility'));
});

test('formatDoctorResult shows unsupported Node versions as runtime warnings', () => {
    const fakeResult = buildFakeDoctorResult({
        runtimeMismatchEvidence: {
            passed: true,
            current_node_version: 'v23.0.0',
            required_range: '^22.13.0 || >=24.0.0',
            violations: [],
            warnings: ['Node.js v23.0.0 is outside the tested support matrix ^22.13.0 || >=24.0.0. Execution is allowed, but this runtime is not covered by CI or release validation.']
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Doctor: PASSED'));
    assert.ok(output.includes('Runtime Compatibility'));
    assert.ok(output.includes('Status: WARN'));
    assert.ok(output.includes('Warning: Node.js v23.0.0 is outside the tested support matrix ^22.13.0 || >=24.0.0.'));
    assert.equal(output.includes('Doctor Failure Summary'), false);
});

test('formatDoctorResult orders multiple top blockers deterministically', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        verifyResult: {
            ...buildFakeDoctorResult().verifyResult,
            passed: false,
            totalViolationCount: 1,
            violations: {
                ...buildFakeDoctorResult().verifyResult.violations,
                missingPaths: ['TASK.md missing.']
            }
        },
        protectedManifestEvidence: {
            status: 'DRIFT' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
            manifest: null
        },
        protectedManifestAssessment: {
            code: 'BLOCKING_DRIFT' as const,
            severity: 'fail' as const,
            blocks: true,
            requires_refresh: true
        },
        runtimeMismatchEvidence: {
            passed: false,
            current_node_version: 'v18.0.0',
            required_range: '^22.13.0 || >=24.0.0',
            violations: []
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.indexOf('Verify failed: 1 violation') < output.indexOf('Protected Control-Plane Manifest is DRIFT'));
    assert.ok(output.indexOf('Protected Control-Plane Manifest is DRIFT') < output.indexOf('Runtime compatibility check failed for Node v18.0.0'));
});


test('formatDoctorResult shows nested bundle duplication warning', () => {
    const fakeResult = buildFakeDoctorResult({
        nestedBundleDuplication: {
            duplicatesFound: true,
            duplicatePaths: ['garda-agent-orchestrator/garda-agent-orchestrator']
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Nested Bundle Duplication'));
    assert.ok(output.includes('DUPLICATES_FOUND'));
    assert.ok(output.includes('garda-agent-orchestrator/garda-agent-orchestrator'));
});


test('formatDoctorResult includes protected manifest section in clean output', () => {
    const fakeResult = buildFakeDoctorResult({
        protectedManifestEvidence: {
            status: 'MATCH' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: [],
            manifest: null
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Protected Control-Plane Manifest'));
    assert.ok(output.includes('Status: MATCH'));
    assert.ok(output.includes('Doctor: PASSED'));
});

test('formatDoctorResult includes non-blocking large module decomposition report', () => {
    const fakeResult = buildFakeDoctorResult({
        largeModuleReport: {
            schema_version: 1,
            mode: 'REPORT_ONLY',
            target_root: '/tmp/test',
            scanned_roots: ['src', 'tests'],
            ignored_roots: ['.git', 'coverage', 'dist', 'node_modules', 'garda-agent-orchestrator'],
            file_extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
            generated_file_policy: 'test fixture',
            summary: {
                scanned_file_count: 2,
                total_lines: 1500,
                largest_source_lines: 900,
                largest_test_lines: 600,
                files_with_todo_follow_up: 1
            },
            top_source_files: [{
                relative_path: 'src/gates/next-step/next-step.ts',
                category: 'source',
                line_count: 900,
                byte_count: 45000,
                owner_tasks: [{
                    task_id: 'T-683',
                    status: '🟪 DECOMPOSED',
                    title: 'Decompose next-step'
                }, {
                    task_id: 'T-683-1',
                    status: '🟦 TODO',
                    title: 'Slim coordinator'
                }],
                todo_follow_up_exists: true
            }],
            top_test_files: [{
                relative_path: 'tests/node/cli/commands/gates/review-result/gates-command-review-result-receipt.test.ts',
                category: 'test',
                line_count: 600,
                byte_count: 30000,
                owner_tasks: [],
                todo_follow_up_exists: false
            }],
            top_declarations: [{
                relative_path: 'src/gates/next-step/next-step.ts',
                declaration_kind: 'function',
                declaration_name: 'resolveNextStep',
                start_line: 10,
                end_line: 500,
                line_count: 491,
                owner_tasks: [{
                    task_id: 'T-683-1',
                    status: '🟦 TODO',
                    title: 'Slim coordinator'
                }],
                todo_follow_up_exists: true
            }],
            next_step_module_budget: {
                schema_version: 1,
                mode: 'REPORT_ONLY',
                coordinator_line_budget: 4500,
                helper_line_budget: 700,
                status: 'OVER_BUDGET',
                total_module_count: 2,
                total_lines: 2105,
                largest_helper_lines: 1105,
                over_budget_count: 1,
                modules: [{
                    relative_path: 'src/gates/next-step/next-step-review-artifact-readers.ts',
                    role: 'helper',
                    responsibility: 'review artifact, receipt, scoped-diff, and trust reads',
                    line_count: 1105,
                    line_budget: 700,
                    budget_status: 'OVER_BUDGET',
                    owner_tasks: [{
                        task_id: 'T-683-2',
                        status: '🟩 DONE',
                        title: 'Review artifact readers'
                    }],
                    todo_follow_up_exists: false,
                    exception_reason: 'Report-only budget exception: keep a concrete decomposition follow-up before raising this threshold.'
                }, {
                    relative_path: 'src/gates/next-step/next-step.ts',
                    role: 'coordinator',
                    responsibility: 'public navigator coordinator and result assembly',
                    line_count: 1000,
                    line_budget: 4500,
                    budget_status: 'WITHIN_BUDGET',
                    owner_tasks: [{
                        task_id: 'T-683-1',
                        status: '🟦 TODO',
                        title: 'Slim coordinator'
                    }],
                    todo_follow_up_exists: true,
                    exception_reason: null
                }]
            }
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Large Module Decomposition Report'));
    assert.ok(output.includes('Mode: REPORT_ONLY'));
    assert.ok(output.includes('Role: recurring size and responsibility signal'));
    assert.ok(output.includes('Next-step module budget: status=OVER_BUDGET, modules=2, total_lines=2105, coordinator_budget=4500, helper_budget=700, largest_helper=1105, over_budget=1'));
    assert.ok(output.includes('src/gates/next-step/next-step-review-artifact-readers.ts: 1105/700 lines role=helper status=OVER_BUDGET responsibility=review artifact, receipt, scoped-diff, and trust reads owner=T-683-2(🟩 DONE) follow_up=no exception=Report-only budget exception'));
    assert.ok(output.includes('src/gates/next-step/next-step.ts: 900 lines owner=T-683(🟪 DECOMPOSED), T-683-1(🟦 TODO) follow_up=yes'));
    assert.ok(output.includes('tests/node/cli/commands/gates/review-result/gates-command-review-result-receipt.test.ts: 600 lines owner=unknown follow_up=no'));
    assert.ok(output.includes('src/gates/next-step/next-step.ts:10 function resolveNextStep spans 491 lines owner=T-683-1(🟦 TODO) follow_up=yes'));
    assert.ok(output.includes('Doctor: PASSED'));
});

test('formatDoctorResult treats source-checkout protected-manifest drift as informational', () => {
    const fakeResult = buildFakeDoctorResult({
        protectedManifestEvidence: {
            status: 'DRIFT' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: ['src/cli/status-helper.ts', 'dist/src/index.js'],
            manifest: {
                schema_version: 1,
                event_source: 'refresh-protected-control-plane-manifest' as const,
                timestamp_utc: '2026-04-23T00:00:00.000Z',
                workspace_root: '/tmp/test',
                orchestrator_root: '/tmp/test/garda-agent-orchestrator',
                protected_roots: ['src/cli/', 'dist/'],
                protected_snapshot: {},
                is_source_checkout: true
            }
        },
        protectedManifestAssessment: {
            code: 'INFO_SOURCE_CHECKOUT' as const,
            severity: 'warn' as const,
            blocks: false,
            requires_refresh: false
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Protected Control-Plane Manifest'));
    assert.ok(output.includes('Assessment: INFO_SOURCE_CHECKOUT'));
    assert.ok(output.includes('Informational in a self-hosted source checkout'));
    assert.ok(output.includes('Doctor: PASSED'));
});

test('formatDoctorResult distinguishes source-checkout inherited protected-manifest drift', () => {
    const fakeResult = buildFakeDoctorResult({
        protectedManifestEvidence: {
            status: 'DRIFT' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
            manifest: {
                schema_version: 1,
                event_source: 'refresh-protected-control-plane-manifest' as const,
                timestamp_utc: '2026-04-23T00:00:00.000Z',
                workspace_root: '/tmp/test',
                orchestrator_root: '/tmp/test/garda-agent-orchestrator',
                protected_roots: ['garda-agent-orchestrator/live/docs/agent-rules/'],
                protected_snapshot: {},
                is_source_checkout: true
            }
        },
        protectedManifestAssessment: {
            code: 'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT' as const,
            severity: 'warn' as const,
            blocks: false,
            requires_refresh: true
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Protected Control-Plane Manifest'));
    assert.ok(output.includes('Assessment: INFO_SOURCE_CHECKOUT_INHERITED_DRIFT'));
    assert.ok(output.includes('clean source checkout inherited protected-manifest drift from prior committed control-plane work'));
    assert.ok(output.includes('run repair protected-manifest after operator verification'));
    assert.ok(output.includes('Doctor: PASSED'));
});


test('formatDoctorResult includes runtime compatibility section', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: false,
            current_node_version: 'v18.0.0',
            required_range: '^22.13.0 || >=24.0.0',
            violations: ['Unable to parse engine range: ^22.13.0 || >=24.0.0']
        },
        permissionEvidence: { passed: true, checks: [] },
        partialStateEvidence: {
            passed: true,
            update_sentinel: null,
            uninstall_sentinel: null,
            lifecycle_lock_exists: false,
            lifecycle_lock_owner: null,
            violations: []
        },
        rollbackHealthEvidence: {
            passed: true,
            snapshots_root: '/tmp/test/rollbacks',
            snapshot_count: 0,
            snapshots: [],
            violations: []
        },
        profileHealthEvidence: null,
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Runtime Compatibility'));
    assert.ok(output.includes('Node: v18.0.0'));
    assert.ok(output.includes('Status: FAILED'));
    assert.ok(output.includes('Doctor: FAIL'));
});


test('formatDoctorResult includes rollback snapshot section when snapshots exist', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: true,
            current_node_version: process.version,
            required_range: NODE_ENGINE_RANGE,
            violations: []
        },
        permissionEvidence: { passed: true, checks: [] },
        partialStateEvidence: {
            passed: true,
            update_sentinel: null,
            uninstall_sentinel: null,
            lifecycle_lock_exists: false,
            lifecycle_lock_owner: null,
            violations: []
        },
        rollbackHealthEvidence: {
            passed: false,
            snapshots_root: '/tmp/test/rollbacks',
            snapshot_count: 1,
            snapshots: [{
                path: '/tmp/test/rollbacks/update-20260401-100000',
                name: 'update-20260401-100000',
                has_records: false,
                records_valid: false,
                records_error: null
            }],
            violations: ['Snapshot update-20260401-100000: missing rollback-records.json']
        },
        profileHealthEvidence: null,
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Rollback Snapshots'));
    assert.ok(output.includes('Count: 1'));
    assert.ok(output.includes('DEGRADED'));
    assert.ok(output.includes('update-20260401-100000'));
    assert.ok(output.includes('Doctor: FAIL'));
});


test('formatDoctorResult shows partial-state section when sentinel detected', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: true,
            current_node_version: process.version,
            required_range: NODE_ENGINE_RANGE,
            violations: []
        },
        permissionEvidence: { passed: true, checks: [] },
        partialStateEvidence: {
            passed: false,
            update_sentinel: { startedAt: '2026-04-01T10:00:00Z', fromVersion: '2.3.0', toVersion: '2.4.0' },
            uninstall_sentinel: null,
            lifecycle_lock_exists: false,
            lifecycle_lock_owner: null,
            violations: ['Interrupted update detected (from 2.3.0 to 2.4.0, started 2026-04-01T10:00:00Z). Run update or rollback to recover.']
        },
        rollbackHealthEvidence: {
            passed: true,
            snapshots_root: '/tmp/test/rollbacks',
            snapshot_count: 0,
            snapshots: [],
            violations: []
        },
        profileHealthEvidence: null,
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Partial State'));
    assert.ok(output.includes('DETECTED'));
    assert.ok(output.includes('Interrupted update'));
    assert.ok(output.includes('Doctor: FAIL'));
});


test('formatDoctorResult shows profile health section for healthy profile', () => {
    const fakeResult = buildFakeDoctorResult({
        profileHealthEvidence: {
            passed: true,
            active_profile: 'balanced',
            profile_source: 'built_in' as const,
            config_path: '/tmp/test/garda-agent-orchestrator/live/config/profiles.json',
            config_exists: true,
            profile_count: 4,
            violations: []
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Profile Health'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('ProfileSource: built_in'));
    assert.ok(output.includes('ProfileCount: 4'));
    assert.ok(output.includes('Status: HEALTHY'));
});

test('formatDoctorResult uses deployed profile command prefix in PASS guidance', () => {
    const workspace = createDoctorWorkspace();
    try {
        const profilesPath = path.join(workspace.bundlePath, 'live', 'config', 'profiles.json');
        fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
        fs.writeFileSync(profilesPath, JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced profile',
                    depth: 2,
                    review_policy: {},
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: false,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: {}
                }
            },
            user_profiles: {}
        }, null, 2), 'utf8');

        const fakeResult = buildFakeDoctorResult({
            targetRoot: workspace.tmpDir,
            verifyResult: {
                ...buildFakeDoctorResult().verifyResult,
                targetRoot: workspace.tmpDir
            }
        });
        const output = formatDoctorResult(fakeResult);
        assert.ok(output.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(!output.includes('node bin/garda.js profile current|list|use|create --target-root "."'));
    } finally {
        workspace.cleanup();
    }
});

test('formatDoctorResult shows NOT_CONFIGURED when profiles config absent', () => {
    const fakeResult = buildFakeDoctorResult({
        profileHealthEvidence: {
            passed: false,
            active_profile: null,
            profile_source: null,
            config_path: '/tmp/test/garda-agent-orchestrator/live/config/profiles.json',
            config_exists: false,
            profile_count: 0,
            violations: ['Profiles config not found']
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Profile Health'));
    assert.ok(output.includes('Status: NOT_CONFIGURED'));
});


test('formatDoctorResultCompact includes profile suffix for healthy profile', () => {
    const fakeResult = buildFakeDoctorResult({
        profileHealthEvidence: {
            passed: true,
            active_profile: 'strict',
            profile_source: 'built_in' as const,
            config_path: '/tmp/test/profiles.json',
            config_exists: true,
            profile_count: 3,
            violations: []
        }
    });

    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(output.includes('profile=strict'));
});


test('formatDoctorResultCompact emits single line on success', () => {
    const fakeResult = buildFakeDoctorResult();
    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(!output.includes('\n'), 'Compact success output must be a single line');
    assert.ok(output.includes('Doctor: PASSED'));
    assert.ok(output.includes('verify=PASSED'));
    assert.ok(output.includes('manifest=PASSED'));
    assert.ok(!output.includes('verify=PASS |'), 'compact output must not rely on PASS as a prefix of PASSED');
    assert.ok(!output.includes('manifest=PASS |'), 'compact output must not rely on PASS as a prefix of PASSED');
});

test('documented doctor compact success output matches formatter contract', () => {
    const output = formatDoctorResultCompact(buildFakeDoctorResult());
    const cliReference = fs.readFileSync(path.join(process.cwd(), 'docs', 'cli-reference.md'), 'utf8');
    const nodeRuntimeContract = fs.readFileSync(path.join(process.cwd(), 'docs', 'node-runtime-contract.md'), 'utf8');

    assert.ok(cliReference.includes(output));
    assert.ok(nodeRuntimeContract.includes(output));
});

test('formatDoctorResultCompact emits full output on failure', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        verifyResult: {
            passed: false,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: ['some/path'],
                initAnswersContractViolations: [],
                versionContractViolations: [],
                reviewCapabilitiesContractViolations: [],
                pathsContractViolations: [],
                tokenEconomyContractViolations: [],
                outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [],
                skillsIndexConfigContractViolations: [],
                ruleFileViolations: [],
                templatePlaceholderViolations: [],
                commandsContractViolations: [],
                manifestContractViolations: [],
                coreRuleContractViolations: [],
                entrypointContractViolations: [],
                taskContractViolations: [],
                qwenSettingsViolations: [],
                skillsIndexContractViolations: [],
                skillPackContractViolations: [],
                gitignoreMissing: []
            },
            totalViolationCount: 1
        },
        manifestResult: null
    });
    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(output.includes('Doctor: FAIL'), 'Compact failure must include full failure output');
    assert.ok(output.includes('MissingPathCount: 1'));
});
