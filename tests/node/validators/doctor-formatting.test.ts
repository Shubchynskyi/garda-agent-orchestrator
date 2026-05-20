import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatDoctorResult,
    formatDoctorResultCompact
} from '../../../src/validators/doctor';
import { NODE_ENGINE_RANGE } from '../../../src/core/constants';
import { buildFakeDoctorResult, createDoctorWorkspace, DEFAULT_NEW_EVIDENCE } from './doctor-workspace-builder';

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
        timelineWarnings: ['Timeline completeness INCOMPLETE for T-004: REVIEW_PHASE_STARTED, COMPLETION_GATE_PASSED']
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Timeline Evidence'));
    assert.ok(output.includes('T-004: integrity=PASS, completeness=INCOMPLETE'));
    assert.ok(output.includes('Timeline Warnings'));
    assert.ok(output.includes('REVIEW_PHASE_STARTED'));
    assert.ok(output.includes('Doctor: FAIL'));
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

test('formatDoctorResult summarizes runtime mismatch before detailed runtime section', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: false,
            current_node_version: 'v18.0.0',
            required_range: '>=24.0.0',
            violations: ['Node.js v18.0.0 does not satisfy required range >=24.0.0. Upgrade to >=24.0.0 or later.']
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Runtime mismatch: Node v18.0.0 does not satisfy >=24.0.0.'));
    assert.ok(output.includes('Install a Node.js version that satisfies >=24.0.0, then rerun doctor.'));
    assert.ok(output.indexOf('Runtime mismatch: Node v18.0.0') < output.indexOf('Runtime Compatibility'));
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
            required_range: '>=24.0.0',
            violations: []
        }
    });

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.indexOf('Verify failed: 1 violation') < output.indexOf('Protected Control-Plane Manifest is DRIFT'));
    assert.ok(output.indexOf('Protected Control-Plane Manifest is DRIFT') < output.indexOf('Runtime mismatch: Node v18.0.0'));
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


test('formatDoctorResult includes runtime compatibility section', () => {
    const fakeResult = buildFakeDoctorResult({
        passed: false,
        runtimeMismatchEvidence: {
            passed: false,
            current_node_version: 'v18.0.0',
            required_range: '>=24.0.0',
            violations: ['Node.js v18.0.0 does not satisfy required range >=24.0.0. Upgrade to >=24.0.0 or later.']
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
    assert.ok(output.includes('Status: MISMATCH'));
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
