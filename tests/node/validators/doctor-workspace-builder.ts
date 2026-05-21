/**
 * Transparent workspace builders for doctor test suites.
 *
 * Each helper creates exactly the directory structure it describes so callers
 * can see precisely which paths exist before assertions run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NODE_ENGINE_RANGE } from '../../../src/core/constants';
import type { DoctorResult } from '../../../src/validators/doctor';

// ── Default evidence block reused by every fake-result factory ────────────

export const DEFAULT_NEW_EVIDENCE = {
    runtimeMismatchEvidence: {
        passed: true,
        current_node_version: process.version,
        required_range: NODE_ENGINE_RANGE,
        violations: [] as string[]
    },
    permissionEvidence: {
        passed: true,
        checks: [] as unknown[]
    },
    partialStateEvidence: {
        passed: true,
        update_sentinel: null as null,
        uninstall_sentinel: null as null,
        lifecycle_lock_exists: false,
        lifecycle_lock_owner: null as null,
        violations: [] as string[]
    },
    rollbackHealthEvidence: {
        passed: true,
        snapshots_root: '/tmp/test/garda-agent-orchestrator/runtime/update-rollbacks',
        snapshot_count: 0,
        snapshots: [] as unknown[],
        violations: [] as string[]
    },
    profileHealthEvidence: null as null
};

// ── Minimal bundle workspace (tmpDir + garda-agent-orchestrator/) ─────────

export interface DoctorWorkspace {
    tmpDir: string;
    bundlePath: string;
    cleanup(): void;
}

/** Create a temp workspace with a valid bundle directory and optional MANIFEST. */
export function createDoctorWorkspace(opts?: {
    manifestContent?: string;
    skipManifest?: boolean;
}): DoctorWorkspace {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });
    if (!opts?.skipManifest) {
        fs.writeFileSync(
            path.join(bundlePath, 'MANIFEST.md'),
            opts?.manifestContent ?? '- bin/garda.js\n- package.json\n',
            'utf8'
        );
    }
    return {
        tmpDir,
        bundlePath,
        cleanup() { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    };
}

/** Seed a stale lock directory with an owner.json for a dead PID. */
export function seedStaleLock(
    lockDir: string,
    opts?: { pid?: number; hostname?: string; createdAt?: string; ageMinutes?: number }
): void {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: opts?.pid ?? 999999,
        hostname: opts?.hostname ?? os.hostname(),
        created_at_utc: opts?.createdAt ?? '2026-03-30T10:00:00.000Z'
    }, null, 2) + '\n', 'utf8');

    if (opts?.ageMinutes !== undefined) {
        const oldTime = new Date(Date.now() - (opts.ageMinutes * 60 * 1000));
        fs.utimesSync(lockDir, oldTime, oldTime);
    }
}

// ── Fake DoctorResult factories for formatting tests ──────────────────────

const EMPTY_VIOLATIONS = {
    missingPaths: [] as string[],
    initAnswersContractViolations: [] as string[],
    versionContractViolations: [] as string[],
    reviewCapabilitiesContractViolations: [] as string[],
    pathsContractViolations: [] as string[],
    tokenEconomyContractViolations: [] as string[],
    outputFiltersContractViolations: [] as string[],
    skillPacksConfigContractViolations: [] as string[],
    skillsIndexConfigContractViolations: [] as string[],
    ruleFileViolations: [] as string[],
    templatePlaceholderViolations: [] as string[],
    commandsContractViolations: [] as string[],
    manifestContractViolations: [] as string[],
    coreRuleContractViolations: [] as string[],
    entrypointContractViolations: [] as string[],
    taskContractViolations: [] as string[],
    qwenSettingsViolations: [] as string[],
    skillsIndexContractViolations: [] as string[],
    skillPackContractViolations: [] as string[],
    gitignoreMissing: [] as string[]
};

/** Build a passing fake DoctorResult with optional overrides. */
export function buildFakeDoctorResult(overrides?: Record<string, unknown>): DoctorResult {
    const base = {
        passed: true,
        targetRoot: '/tmp/test',
        verifyResult: {
            passed: true,
            targetRoot: '/tmp/test',
            sourceOfTruth: 'Claude',
            canonicalEntrypoint: 'CLAUDE.md',
            bundleVersion: '1.0.0',
            requiredPathsChecked: 10,
            violations: { ...EMPTY_VIOLATIONS },
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
        protectedManifestAssessment: null,
        ...DEFAULT_NEW_EVIDENCE,
        taskHistoryLedgerSummary: {
            root_path: '/tmp/test/garda-agent-orchestrator/runtime/task-ledger',
            file_count: 0,
            verified_count: 0,
            incomplete_count: 0,
            contradictory_count: 0,
            invalid_count: 0
        },
        ...overrides
    };
    return base as unknown as DoctorResult;
}
