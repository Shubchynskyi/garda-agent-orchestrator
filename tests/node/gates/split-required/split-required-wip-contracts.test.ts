import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    findCurrentCapturedManifest,
    findManifestPaths,
    readManifest,
    resolveWipRoot,
    sha256FileRequired,
    SPLIT_REQUIRED_WIP_SCHEMA_VERSION
} from '../../../../src/gates/split-required/split-required-wip-contracts';
import type {
    SplitRequiredWipCaptureResult as ExtractedCaptureResult,
    SplitRequiredWipGuardKind as ExtractedGuardKind,
    SplitRequiredWipListEntry as ExtractedListEntry,
    SplitRequiredWipListResult as ExtractedListResult,
    SplitRequiredWipManifest as ExtractedManifest,
    SplitRequiredWipPatchEvidence as ExtractedPatchEvidence,
    SplitRequiredWipRestoreResult as ExtractedRestoreResult,
    SplitRequiredWipRetireResult as ExtractedRetireResult,
    SplitRequiredWipTrackedFileEvidence as ExtractedTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence as ExtractedUntrackedFileEvidence
} from '../../../../src/gates/split-required/split-required-wip-contracts';
import type {
    SplitRequiredWipCaptureResult as FacadeCaptureResult,
    SplitRequiredWipGuardKind as FacadeGuardKind,
    SplitRequiredWipListEntry as FacadeListEntry,
    SplitRequiredWipListResult as FacadeListResult,
    SplitRequiredWipManifest as FacadeManifest,
    SplitRequiredWipPatchEvidence as FacadePatchEvidence,
    SplitRequiredWipRestoreResult as FacadeRestoreResult,
    SplitRequiredWipRetireResult as FacadeRetireResult,
    SplitRequiredWipTrackedFileEvidence as FacadeTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence as FacadeUntrackedFileEvidence
} from '../../../../src/gates/split-required/split-required-wip';

type FacadePublicContracts = {
    capture: FacadeCaptureResult;
    guard: FacadeGuardKind;
    listEntry: FacadeListEntry;
    list: FacadeListResult;
    manifest: FacadeManifest;
    patch: FacadePatchEvidence;
    restore: FacadeRestoreResult;
    retire: FacadeRetireResult;
    tracked: FacadeTrackedFileEvidence;
    untracked: FacadeUntrackedFileEvidence;
};

type ExtractedPublicContracts = {
    capture: ExtractedCaptureResult;
    guard: ExtractedGuardKind;
    listEntry: ExtractedListEntry;
    list: ExtractedListResult;
    manifest: ExtractedManifest;
    patch: ExtractedPatchEvidence;
    restore: ExtractedRestoreResult;
    retire: ExtractedRetireResult;
    tracked: ExtractedTrackedFileEvidence;
    untracked: ExtractedUntrackedFileEvidence;
};

type PublicContractsAreCompatible = FacadePublicContracts extends ExtractedPublicContracts
    ? ExtractedPublicContracts extends FacadePublicContracts
        ? true
        : false
    : false;

function manifestFixture(
    preflightSha256: string,
    overrides: Partial<ExtractedManifest> = {}
): ExtractedManifest {
    return {
        schema_version: SPLIT_REQUIRED_WIP_SCHEMA_VERSION,
        kind: 'split_required_wip',
        status: 'suspended',
        task_id: 'T-WIP-CONTRACTS',
        guard_kind: 'scope_budget',
        guard_reason: 'test',
        created_at_utc: '2026-07-30T00:00:00.000Z',
        base_commit: '0123456789abcdef',
        preflight_path: 'runtime/reviews/T-WIP-CONTRACTS-preflight.json',
        preflight_sha256: preflightSha256,
        patches: {
            staged: {
                path: 'runtime/wip/staged.patch',
                sha256: 'staged',
                bytes: 0,
                empty: true
            },
            unstaged: {
                path: 'runtime/wip/unstaged.patch',
                sha256: 'unstaged',
                bytes: 0,
                empty: true
            }
        },
        tracked_files: [],
        untracked_files: [],
        unrelated_untracked_files: [],
        ignored_runtime_artifacts: [],
        restore_commands: {
            list: 'list',
            preview_full: 'preview-full',
            restore_full: 'restore-full',
            preview_partial_template: 'preview-partial',
            restore_partial_template: 'restore-partial',
            retire: 'retire'
        },
        ...overrides
    };
}

function writeManifest(manifestPath: string, manifest: ExtractedManifest): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

describe('split-required WIP contracts', () => {
    it('preserves every public type export through the compatibility facade', () => {
        const compatible: PublicContractsAreCompatible = true;
        assert.equal(compatible, true);
    });

    it('discovers manifests deterministically and selects the latest matching suspended capture', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-split-wip-contracts-'));
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-WIP-CONTRACTS';
        const preflightPath = path.join(repoRoot, 'preflight.json');
        fs.writeFileSync(preflightPath, '{"task":"contracts"}\n', 'utf8');
        const preflightSha256 = sha256FileRequired(preflightPath);
        const wipRoot = resolveWipRoot(repoRoot, taskId);
        const invalidPath = path.join(wipRoot, '2026-07-30T00-00-00-000Z', 'manifest.json');
        const firstPath = path.join(wipRoot, '2026-07-30T00-00-01-000Z', 'manifest.json');
        const currentPath = path.join(wipRoot, '2026-07-30T00-00-02-000Z', 'manifest.json');
        const wrongTaskPath = path.join(wipRoot, '2026-07-30T00-00-03-000Z', 'manifest.json');
        const stalePreflightPath = path.join(wipRoot, '2026-07-30T00-00-04-000Z', 'manifest.json');
        const retiredPath = path.join(wipRoot, '2026-07-30T00-00-05-000Z', 'manifest.json');

        fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
        fs.writeFileSync(invalidPath, '{"kind":"not_split_required_wip"}\n', 'utf8');
        writeManifest(firstPath, manifestFixture(preflightSha256));
        writeManifest(currentPath, manifestFixture(preflightSha256, {
            created_at_utc: '2026-07-30T00:00:02.000Z'
        }));
        writeManifest(wrongTaskPath, manifestFixture(preflightSha256, {
            task_id: 'T-WIP-CONTRACTS-OTHER',
            created_at_utc: '2026-07-30T00:00:03.000Z'
        }));
        writeManifest(stalePreflightPath, manifestFixture('stale-preflight-sha256', {
            created_at_utc: '2026-07-30T00:00:04.000Z'
        }));
        writeManifest(retiredPath, manifestFixture(preflightSha256, {
            status: 'retired',
            created_at_utc: '2026-07-30T00:00:05.000Z'
        }));

        assert.deepEqual(findManifestPaths(repoRoot, taskId), [
            invalidPath,
            firstPath,
            currentPath,
            wrongTaskPath,
            stalePreflightPath,
            retiredPath
        ]);
        assert.equal(readManifest(invalidPath), null);
        assert.equal(
            findCurrentCapturedManifest({
                repoRoot,
                taskId,
                preflightPath,
                guardKind: 'scope_budget'
            })?.path,
            currentPath
        );
        assert.equal(
            findCurrentCapturedManifest({
                repoRoot,
                taskId,
                preflightPath,
                guardKind: 'review_cycle'
            }),
            null
        );
    });
});
