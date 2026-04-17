import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    runDoctor,
    formatDoctorResult,
    formatDoctorResultCompact,
    checkRuntimeMismatch,
    checkPermissions,
    checkPartialState,
    checkRollbackHealth,
    checkProfileHealth
} from '../../../src/validators/doctor';
import {
    writeProtectedControlPlaneManifest
} from '../../../src/gates/helpers';
import {
    writeUpdateSentinel,
    writeUninstallSentinel
} from '../../../src/lifecycle/common';
import {
    getRollbackSnapshotsRoot
} from '../../../src/lifecycle/rollback';
import { NODE_ENGINE_RANGE } from '../../../src/core/constants';

const DEFAULT_NEW_EVIDENCE = {
    runtimeMismatchEvidence: {
        passed: true,
        current_node_version: process.version,
        required_range: NODE_ENGINE_RANGE,
        violations: []
    },
    permissionEvidence: {
        passed: true,
        checks: []
    },
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
        snapshots_root: '/tmp/test/garda-agent-orchestrator/runtime/update-rollbacks',
        snapshot_count: 0,
        snapshots: [],
        violations: []
    },
    profileHealthEvidence: null
};

test('runDoctor throws for missing bundle', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    try {
        assert.throws(
            () => runDoctor({
                targetRoot: tmpDir,
                sourceOfTruth: 'Claude'
            }),
            /Deployed bundle not found/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor runs verify and manifest validation when bundle exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- src/index.ts\n',
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(typeof result.passed, 'boolean');
        assert.ok(result.verifyResult);
        assert.ok(result.manifestResult);
        assert.equal(result.manifestResult.passed, true);
        assert.equal(result.manifestError, null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor reports manifest error for missing MANIFEST.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.manifestError !== null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor detects manifest duplicates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- file.txt\n- file.txt\n',
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.manifestResult);
        assert.equal(result.manifestResult.passed, false);
        assert.equal(result.manifestResult.duplicates.length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult includes verify and manifest output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        const output = formatDoctorResult(result);
        assert.ok(output.includes('TargetRoot:'));
        assert.ok(output.includes('SourceOfTruth: Claude'));
        assert.ok(output.includes('MANIFEST_VALIDATION_PASSED'));
        assert.ok(output.includes('Doctor:'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult shows PASS for clean doctor', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem. runtime/reviews/ is never cleaned by these diagnostics.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Doctor: PASS'));
    assert.ok(output.includes('Next: Execute task T-001'));
});

test('formatDoctorResult includes timeline completeness warnings', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
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
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
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
        timelineWarnings: ['Timeline completeness INCOMPLETE for T-004: REVIEW_PHASE_STARTED, COMPLETION_GATE_PASSED'],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem. runtime/reviews/ is never cleaned by these diagnostics.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Timeline Evidence'));
    assert.ok(output.includes('T-004: integrity=PASS, completeness=INCOMPLETE'));
    assert.ok(output.includes('Timeline Warnings'));
    assert.ok(output.includes('REVIEW_PHASE_STARTED'));
    assert.ok(output.includes('Doctor: FAIL'));
});

test('runDoctor reports stale task-event locks and supports dry-run cleanup output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-locks-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    const staleLockPath = path.join(eventsRoot, '.T-005.lock');
    fs.mkdirSync(staleLockPath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );
    fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        created_at_utc: '2026-03-30T10:00:00.000Z'
    }, null, 2) + '\n', 'utf8');

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: true
        });
        assert.equal(result.passed, false);
        assert.equal(result.lockHealth.stale_count, 1);
        assert.ok(result.lockCleanup !== null);
        assert.deepEqual(result.lockCleanup!.removable_stale_locks, ['.T-005.lock']);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale locks');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Task-Event Lock Cleanup'));
        assert.ok(output.includes('Mode: DRY_RUN'));
        assert.ok(output.includes('.T-005.lock: STALE'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor reports and cleans stale review-artifact locks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-review-locks-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundlePath, 'runtime', 'reviews');
    const staleLockPath = path.join(reviewsRoot, 'T-006-code.md.lock');
    fs.mkdirSync(staleLockPath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );
    fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        created_at_utc: '2026-03-30T10:00:00.000Z'
    }, null, 2) + '\n', 'utf8');
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(staleLockPath, oldTime, oldTime);

    try {
        const dryRun = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: true
        });
        assert.equal(dryRun.passed, false);
        assert.ok(dryRun.reviewLockHealth);
        assert.equal(dryRun.reviewLockHealth!.stale_count, 1);
        assert.ok(dryRun.reviewLockCleanup !== null);
        assert.deepEqual(dryRun.reviewLockCleanup!.removable_stale_locks, ['T-006-code.md.lock']);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale review-artifact locks');

        const applied = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            cleanupStaleLocks: true,
            dryRun: false
        });
        assert.ok(applied.reviewLockCleanup !== null);
        assert.deepEqual(applied.reviewLockCleanup!.removed_locks, ['T-006-code.md.lock']);
        assert.equal(fs.existsSync(staleLockPath), false, 'doctor cleanup should remove stale review-artifact lock');

        const output = formatDoctorResult(dryRun);
        assert.ok(output.includes('Review Artifact Lock Cleanup'));
        assert.ok(output.includes('Review Artifact Locks'));
        assert.ok(output.includes('T-006-code.md.lock: STALE'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor reports the shared stale reviews-index lock in review-artifact diagnostics', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-review-index-lock-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const runtimeDir = path.join(bundlePath, 'runtime');
    const staleLockPath = path.join(runtimeDir, '.reviews-index.lock');
    fs.mkdirSync(staleLockPath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );
    fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        created_at_utc: '2026-03-30T10:00:00.000Z'
    }, null, 2) + '\n', 'utf8');
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(staleLockPath, oldTime, oldTime);

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.ok(result.reviewLockHealth);
        assert.ok(result.reviewLockHealth!.locks.some((lock) => lock.lock_name === '.reviews-index.lock' && lock.status === 'STALE'));

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Review Artifact Locks'));
        assert.ok(output.includes('.reviews-index.lock: STALE'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor includes provider compliance result when activeAgentFiles provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-compliance-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
    const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );
    // Create compliant entrypoint and router
    fs.mkdirSync(path.join(tmpDir, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(
        path.join(tmpDir, '.agents', 'workflows', 'start-task.md'),
        [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(tmpDir, 'AGENTS.md'),
        [MANAGED_START, '# AGENTS.md', 'open `.agents/workflows/start-task.md`.', MANAGED_END].join('\n'),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Codex',
            activeAgentFiles: ['AGENTS.md']
        });
        assert.ok(result.providerComplianceResult !== null);
        assert.equal(result.providerComplianceResult!.passed, true);
        assert.equal(result.providerComplianceResult!.routerExists, true);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Provider Control Compliance'));
        assert.ok(output.includes('Status: PASS'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor fails when active entrypoint has compliance drift', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-drift-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
    const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );
    // Create router but entrypoint without router reference
    fs.mkdirSync(path.join(tmpDir, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(
        path.join(tmpDir, '.agents', 'workflows', 'start-task.md'),
        [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(tmpDir, 'CLAUDE.md'),
        [MANAGED_START, '# CLAUDE.md', 'No router ref.', MANAGED_END].join('\n'),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            activeAgentFiles: ['CLAUDE.md']
        });
        assert.ok(result.providerComplianceResult !== null);
        assert.equal(result.providerComplianceResult!.passed, false);
        assert.equal(result.passed, false);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('DRIFT_DETECTED'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult shows nested bundle duplication warning', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem. runtime/reviews/ is never cleaned by these diagnostics.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: {
            duplicatesFound: true,
            duplicatePaths: ['garda-agent-orchestrator/garda-agent-orchestrator']
        },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Nested Bundle Duplication'));
    assert.ok(output.includes('DUPLICATES_FOUND'));
    assert.ok(output.includes('garda-agent-orchestrator/garda-agent-orchestrator'));
});

test('runDoctor detects nested bundle duplication in real workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-nested-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );

    // Create nested bundle with launcher
    const nestedBundlePath = path.join(bundlePath, 'garda-agent-orchestrator', 'bin');
    fs.mkdirSync(nestedBundlePath, { recursive: true });
    fs.writeFileSync(path.join(nestedBundlePath, 'garda.js'), '#!/usr/bin/env node', 'utf8');

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.nestedBundleDuplication.duplicatesFound, true);
        assert.ok(result.nestedBundleDuplication.duplicatePaths.length > 0);
        assert.equal(result.passed, false, 'doctor overall verdict should fail when nested duplication is detected');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Nested Bundle Duplication'));
        assert.ok(output.includes('DUPLICATES_FOUND'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor surfaces protected-manifest MATCH when trusted manifest is current', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pm-match-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );

    // Build and write a matching trusted manifest from the current workspace state
    writeProtectedControlPlaneManifest(tmpDir);

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'MATCH');
        // MATCH does not fail doctor
        const output = formatDoctorResult(result);
        assert.ok(output.includes('Protected Control-Plane Manifest'));
        assert.ok(output.includes('Status: MATCH'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor surfaces protected-manifest DRIFT and fails overall', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pm-drift-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );

    // Create a protected file and a manifest with stale hash
    const distDir = path.join(bundlePath, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), 'console.log("hi");', 'utf8');

    const runtimeDir = path.join(bundlePath, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
        path.join(runtimeDir, 'protected-control-plane-manifest.json'),
        JSON.stringify({
            schema_version: 1,
            event_source: 'refresh-protected-control-plane-manifest',
            timestamp_utc: new Date().toISOString(),
            workspace_root: tmpDir.replace(/\\/g, '/'),
            orchestrator_root: bundlePath.replace(/\\/g, '/'),
            protected_roots: ['garda-agent-orchestrator/dist'],
            protected_snapshot: {
                'garda-agent-orchestrator/dist/index.js': 'stale-hash-does-not-match'
            },
            is_source_checkout: false
        }, null, 2),
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'DRIFT');
        assert.ok(result.protectedManifestEvidence!.changed_files.length > 0);
        assert.equal(result.passed, false, 'doctor should fail on protected-manifest DRIFT');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Protected Control-Plane Manifest'));
        assert.ok(output.includes('Status: DRIFT'));
        assert.ok(output.includes('DriftCount:'));
        assert.ok(output.includes('Doctor: FAIL'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor surfaces protected-manifest INVALID and fails overall', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pm-invalid-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(
        path.join(bundlePath, 'MANIFEST.md'),
        '- bin/garda.js\n- package.json\n',
        'utf8'
    );

    const runtimeDir = path.join(bundlePath, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
        path.join(runtimeDir, 'protected-control-plane-manifest.json'),
        '{ malformed json',
        'utf8'
    );

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(result.protectedManifestEvidence !== null);
        assert.equal(result.protectedManifestEvidence!.status, 'INVALID');
        assert.equal(result.passed, false, 'doctor should fail on protected-manifest INVALID');

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Status: INVALID'));
        assert.ok(output.includes('regenerate'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult includes protected manifest section in clean output', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem. runtime/reviews/ is never cleaned by these diagnostics.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: {
            status: 'MATCH' as const,
            manifest_path: '/tmp/test/garda-agent-orchestrator/runtime/protected-control-plane-manifest.json',
            changed_files: [],
            manifest: null
        },
        ...DEFAULT_NEW_EVIDENCE
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Protected Control-Plane Manifest'));
    assert.ok(output.includes('Status: MATCH'));
    assert.ok(output.includes('Doctor: PASS'));
});

// ---------------------------------------------------------------------------
// T-012: Runtime mismatch checks
// ---------------------------------------------------------------------------

test('checkRuntimeMismatch passes for current Node.js version', () => {
    const result = checkRuntimeMismatch();
    assert.equal(result.passed, true);
    assert.equal(result.current_node_version, process.version);
    assert.equal(result.required_range, NODE_ENGINE_RANGE);
    assert.equal(result.violations.length, 0);
});

test('checkRuntimeMismatch evidence includes expected fields', () => {
    const result = checkRuntimeMismatch();
    assert.ok(typeof result.passed === 'boolean');
    assert.ok(typeof result.current_node_version === 'string');
    assert.ok(typeof result.required_range === 'string');
    assert.ok(Array.isArray(result.violations));
});

test('formatDoctorResult includes runtime compatibility section', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
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
        profileHealthEvidence: null
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Runtime Compatibility'));
    assert.ok(output.includes('Node: v18.0.0'));
    assert.ok(output.includes('Status: MISMATCH'));
    assert.ok(output.includes('Doctor: FAIL'));
});

// ---------------------------------------------------------------------------
// T-012: Permission checks
// ---------------------------------------------------------------------------

test('checkPermissions passes for accessible workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-perm-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundlePath, 'live', 'config'), { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'VERSION'), '1.0.0\n', 'utf8');
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n', 'utf8');

    try {
        const result = checkPermissions(tmpDir);
        assert.equal(result.passed, true);
        assert.ok(result.checks.length > 0);
        for (const check of result.checks) {
            if (check.exists) {
                assert.equal(check.accessible, true, check.path + ' should be accessible');
            }
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPermissions reports when critical paths do not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-perm-empty-'));
    try {
        const result = checkPermissions(tmpDir);
        assert.ok(typeof result.passed === 'boolean');
        assert.ok(result.checks.length > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T-012: Partial-state detection
// ---------------------------------------------------------------------------

test('checkPartialState passes for clean workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-clean-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.update_sentinel, null);
        assert.equal(result.uninstall_sentinel, null);
        assert.equal(result.lifecycle_lock_exists, false);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects interrupted update sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-update-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    writeUpdateSentinel(bundlePath, {
        startedAt: '2026-04-01T10:00:00.000Z',
        fromVersion: '2.3.0',
        toVersion: '2.4.0'
    });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.update_sentinel !== null);
        assert.equal(result.update_sentinel!.fromVersion, '2.3.0');
        assert.ok(result.violations.some(function (v) { return v.includes('Interrupted update'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects interrupted uninstall sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-uninstall-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    writeUninstallSentinel(tmpDir, {
        startedAt: '2026-04-01T11:00:00.000Z',
        operation: 'uninstall'
    });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.uninstall_sentinel !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('Interrupted uninstall'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects stale lifecycle operation lock', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-lock-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const lockPath = path.join(bundlePath, 'runtime', '.lifecycle-operation.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        operation: 'update',
        acquired_at_utc: '2026-04-01T10:00:00.000Z',
        target_root: tmpDir
    }, null, 2), 'utf8');

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.lifecycle_lock_exists, true);
        assert.ok(result.lifecycle_lock_owner !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('Lifecycle operation lock'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor fails when update sentinel is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-e2e-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n', 'utf8');

    writeUpdateSentinel(bundlePath, {
        startedAt: '2026-04-01T10:00:00.000Z',
        fromVersion: '2.3.0',
        toVersion: '2.4.0'
    });

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.equal(result.passed, false);
        assert.equal(result.partialStateEvidence.passed, false);
        assert.ok(result.partialStateEvidence.update_sentinel !== null);

        const output = formatDoctorResult(result);
        assert.ok(output.includes('Partial State'));
        assert.ok(output.includes('DETECTED'));
        assert.ok(output.includes('Interrupted update'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T-012: Rollback health checks
// ---------------------------------------------------------------------------

test('checkRollbackHealth passes for empty rollback directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-empty-'));
    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.snapshot_count, 0);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth passes for valid snapshot with records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-valid-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        JSON.stringify([{ relativePath: 'some/file.txt', existed: true, pathType: 'file' }]),
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.snapshot_count, 1);
        assert.equal(result.snapshots[0].has_records, true);
        assert.equal(result.snapshots[0].records_valid, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot missing rollback-records.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-norec-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshot_count, 1);
        assert.equal(result.snapshots[0].has_records, false);
        assert.ok(result.violations.some(function (v) { return v.includes('missing rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot with corrupt records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-corrupt-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        'not valid json!!!',
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshots[0].has_records, true);
        assert.equal(result.snapshots[0].records_valid, false);
        assert.ok(result.snapshots[0].records_error !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('corrupt rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot with invalid records structure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-invalid-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        JSON.stringify([{ noRelativePath: true }]),
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshots[0].records_valid, false);
        assert.ok(result.violations.some(function (v) { return v.includes('Invalid rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult includes rollback snapshot section when snapshots exist', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
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
        profileHealthEvidence: null
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Rollback Snapshots'));
    assert.ok(output.includes('Count: 1'));
    assert.ok(output.includes('DEGRADED'));
    assert.ok(output.includes('update-20260401-100000'));
    assert.ok(output.includes('Doctor: FAIL'));
});

test('runDoctor includes all four new evidence fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-full-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n', 'utf8');

    try {
        const result = runDoctor({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude'
        });
        assert.ok(typeof result.runtimeMismatchEvidence === 'object');
        assert.ok(typeof result.runtimeMismatchEvidence.passed === 'boolean');
        assert.ok(typeof result.permissionEvidence === 'object');
        assert.ok(typeof result.permissionEvidence.passed === 'boolean');
        assert.ok(typeof result.partialStateEvidence === 'object');
        assert.ok(typeof result.partialStateEvidence.passed === 'boolean');
        assert.ok(typeof result.rollbackHealthEvidence === 'object');
        assert.ok(typeof result.rollbackHealthEvidence.passed === 'boolean');

        assert.equal(result.runtimeMismatchEvidence.passed, true);
        assert.equal(result.partialStateEvidence.passed, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult shows partial-state section when sentinel detected', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/test/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'scope note',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
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
        profileHealthEvidence: null
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Partial State'));
    assert.ok(output.includes('DETECTED'));
    assert.ok(output.includes('Interrupted update'));
    assert.ok(output.includes('Doctor: FAIL'));
});

/* ------------------------------------------------------------------ */
/*  formatDoctorResultCompact (T-019)                                 */
/* ------------------------------------------------------------------ */

test('formatDoctorResultCompact emits single line on success', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: {
                missingPaths: [],
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
            totalViolationCount: 0
        },
        manifestResult: {
            passed: true,
            manifestPath: '/tmp/MANIFEST.md',
            entriesChecked: 5,
            duplicates: [],
            diagnostics: []
        },
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem. runtime/reviews/ is never cleaned by these diagnostics.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE
    };
    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(!output.includes('\n'), 'Compact success output must be a single line');
    assert.ok(output.includes('Doctor: PASS'));
    assert.ok(output.includes('verify=PASS'));
    assert.ok(output.includes('manifest=PASS'));
});

test('formatDoctorResultCompact emits full output on failure', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
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
        manifestResult: null,
        manifestError: null,
        timelineEvidence: [],
        timelineWarnings: [],
        lockHealth: {
            lock_root: '/tmp/test/runtime/task-events',
            subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem.',
            locks: [],
            active_count: 0,
            stale_count: 0
        },
        lockCleanup: null,
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [],
            rootVersion: null,
            bundleVersion: null,
            remediation: null
        },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE
    };
    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(output.includes('Doctor: FAIL'), 'Compact failure must include full failure output');
    assert.ok(output.includes('MissingPathCount: 1'));
});

// ---------------------------------------------------------------------------
// T-055: Profile health checks
// ---------------------------------------------------------------------------

test('checkProfileHealth returns NOT_CONFIGURED when profiles.json is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'live', 'config'), { recursive: true });

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, false);
        assert.equal(result.active_profile, null);
        assert.equal(result.profile_source, null);
        assert.equal(result.profile_count, 0);
        assert.ok(result.violations.length > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth passes for valid profiles.json with built-in active profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'Default', depth: 2 },
            fast: { description: 'Fast', depth: 1 }
        },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.config_exists, true);
        assert.equal(result.active_profile, 'balanced');
        assert.equal(result.profile_source, 'built_in');
        assert.equal(result.profile_count, 2);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth passes for user-defined active profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'my-custom',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: { 'my-custom': { description: 'Custom', depth: 3 } }
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.active_profile, 'my-custom');
        assert.equal(result.profile_source, 'user');
        assert.equal(result.profile_count, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when active profile does not match any defined profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'nonexistent',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, true);
        assert.equal(result.active_profile, 'nonexistent');
        assert.equal(result.profile_source, null);
        assert.ok(result.violations.some(v => v.includes('does not match')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when no active_profile is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: '',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('no active_profile')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when no built-in profiles exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {},
        user_profiles: { custom: { description: 'Only user', depth: 2 } }
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('built-in profile')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), '{ broken json', 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, true);
        assert.ok(result.violations.some(v => v.includes('invalid JSON')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDoctorResult shows profile health section for healthy profile', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true, targetRoot: '/tmp/test', sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md', bundleVersion: '1.0.0', requiredPathsChecked: 10,
            violations: {
                missingPaths: [], initAnswersContractViolations: [], versionContractViolations: [],
                reviewCapabilitiesContractViolations: [], pathsContractViolations: [],
                tokenEconomyContractViolations: [], outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [], skillsIndexConfigContractViolations: [],
                ruleFileViolations: [], templatePlaceholderViolations: [], commandsContractViolations: [],
                manifestContractViolations: [], coreRuleContractViolations: [], entrypointContractViolations: [],
                taskContractViolations: [], qwenSettingsViolations: [], skillsIndexContractViolations: [],
                skillPackContractViolations: [], gitignoreMissing: []
            }, totalViolationCount: 0
        },
        manifestResult: { passed: true, manifestPath: '/tmp/test/MANIFEST.md', entriesChecked: 5, duplicates: [], diagnostics: [] },
        manifestError: null,
        timelineEvidence: [], timelineWarnings: [],
        lockHealth: { lock_root: '/tmp/test', subsystem_scope_note: 'note', locks: [], active_count: 0, stale_count: 0 },
        lockCleanup: null,
        parityResult: { isSourceCheckout: false, isStale: false, violations: [], rootVersion: null, bundleVersion: null, remediation: null },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE,
        profileHealthEvidence: {
            passed: true,
            active_profile: 'balanced',
            profile_source: 'built_in' as const,
            config_path: '/tmp/test/garda-agent-orchestrator/live/config/profiles.json',
            config_exists: true,
            profile_count: 4,
            violations: []
        }
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Profile Health'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('ProfileSource: built_in'));
    assert.ok(output.includes('ProfileCount: 4'));
    assert.ok(output.includes('Status: HEALTHY'));
});

test('formatDoctorResult shows NOT_CONFIGURED when profiles config absent', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true, targetRoot: '/tmp/test', sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md', bundleVersion: '1.0.0', requiredPathsChecked: 10,
            violations: {
                missingPaths: [], initAnswersContractViolations: [], versionContractViolations: [],
                reviewCapabilitiesContractViolations: [], pathsContractViolations: [],
                tokenEconomyContractViolations: [], outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [], skillsIndexConfigContractViolations: [],
                ruleFileViolations: [], templatePlaceholderViolations: [], commandsContractViolations: [],
                manifestContractViolations: [], coreRuleContractViolations: [], entrypointContractViolations: [],
                taskContractViolations: [], qwenSettingsViolations: [], skillsIndexContractViolations: [],
                skillPackContractViolations: [], gitignoreMissing: []
            }, totalViolationCount: 0
        },
        manifestResult: { passed: true, manifestPath: '/tmp/test/MANIFEST.md', entriesChecked: 5, duplicates: [], diagnostics: [] },
        manifestError: null,
        timelineEvidence: [], timelineWarnings: [],
        lockHealth: { lock_root: '/tmp/test', subsystem_scope_note: 'note', locks: [], active_count: 0, stale_count: 0 },
        lockCleanup: null,
        parityResult: { isSourceCheckout: false, isStale: false, violations: [], rootVersion: null, bundleVersion: null, remediation: null },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE,
        profileHealthEvidence: {
            passed: false,
            active_profile: null,
            profile_source: null,
            config_path: '/tmp/test/garda-agent-orchestrator/live/config/profiles.json',
            config_exists: false,
            profile_count: 0,
            violations: ['Profiles config not found']
        }
    };

    const output = formatDoctorResult(fakeResult);
    assert.ok(output.includes('Profile Health'));
    assert.ok(output.includes('Status: NOT_CONFIGURED'));
});

test('formatDoctorResultCompact includes profile suffix for healthy profile', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true, targetRoot: '/tmp/test', sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md', bundleVersion: '1.0.0', requiredPathsChecked: 10,
            violations: {
                missingPaths: [], initAnswersContractViolations: [], versionContractViolations: [],
                reviewCapabilitiesContractViolations: [], pathsContractViolations: [],
                tokenEconomyContractViolations: [], outputFiltersContractViolations: [],
                skillPacksConfigContractViolations: [], skillsIndexConfigContractViolations: [],
                ruleFileViolations: [], templatePlaceholderViolations: [], commandsContractViolations: [],
                manifestContractViolations: [], coreRuleContractViolations: [], entrypointContractViolations: [],
                taskContractViolations: [], qwenSettingsViolations: [], skillsIndexContractViolations: [],
                skillPackContractViolations: [], gitignoreMissing: []
            }, totalViolationCount: 0
        },
        manifestResult: { passed: true, manifestPath: '/tmp/test/MANIFEST.md', entriesChecked: 5, duplicates: [], diagnostics: [] },
        manifestError: null,
        timelineEvidence: [], timelineWarnings: [],
        lockHealth: { lock_root: '/tmp/test', subsystem_scope_note: 'note', locks: [], active_count: 0, stale_count: 0 },
        lockCleanup: null,
        parityResult: { isSourceCheckout: false, isStale: false, violations: [], rootVersion: null, bundleVersion: null, remediation: null },
        providerComplianceResult: null,
        nestedBundleDuplication: { duplicatesFound: false, duplicatePaths: [] },
        protectedManifestEvidence: null,
        ...DEFAULT_NEW_EVIDENCE,
        profileHealthEvidence: {
            passed: true,
            active_profile: 'strict',
            profile_source: 'built_in' as const,
            config_path: '/tmp/test/profiles.json',
            config_exists: true,
            profile_count: 3,
            violations: []
        }
    };

    const output = formatDoctorResultCompact(fakeResult);
    assert.ok(output.includes('profile=strict'));
});

test('runDoctor includes profile health evidence when profiles.json exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-int-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n- package.json\n', 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = runDoctor({ targetRoot: tmpDir, sourceOfTruth: 'Claude' });
        assert.ok(result.profileHealthEvidence !== null);
        assert.equal(result.profileHealthEvidence!.passed, true);
        assert.equal(result.profileHealthEvidence!.active_profile, 'balanced');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('runDoctor fails when profiles.json has dangling active_profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-fail-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n- package.json\n', 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'nonexistent',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = runDoctor({ targetRoot: tmpDir, sourceOfTruth: 'Claude' });
        assert.ok(result.profileHealthEvidence !== null);
        assert.equal(result.profileHealthEvidence!.passed, false);
        assert.equal(result.passed, false, 'doctor should fail when profile config has violations');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
