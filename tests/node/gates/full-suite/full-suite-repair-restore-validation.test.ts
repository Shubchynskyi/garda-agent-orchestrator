import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
    CapturedPatchEvidence,
    CapturedUntrackedFileEvidence,
    RepairWipManifest
} from '../../../../src/gates/full-suite/full-suite-repair-contracts';
import {
    decodeGitExtendedHeaderPath,
    inspectRestoreMutationState,
    parsePatchExtendedPathRecords,
    rollbackFullSuiteRepairRestore,
    validateDescendantRestoreHead,
    validateManifestPatchBindings,
    validateManifestFileReferences
} from '../../../../src/gates/full-suite/full-suite-repair-restore-validation';

function sha256(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

function writeArtifact(repoRoot: string, relativePath: string, content: Buffer): CapturedPatchEvidence {
    const artifactPath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);
    return {
        path: relativePath,
        sha256: sha256(content),
        bytes: content.byteLength,
        empty: content.byteLength === 0
    };
}

function runGit(repoRoot: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8'
    });
}

function readGit(repoRoot: string, args: string[]): Buffer {
    return execFileSync('git', args, {
        cwd: repoRoot
    });
}

function initializeRepo(repoRoot: string): string {
    runGit(repoRoot, ['init', '--quiet']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'file.ts'), 'base\n', 'utf8');
    runGit(repoRoot, ['add', 'src/file.ts']);
    runGit(repoRoot, ['commit', '--quiet', '-m', 'seed']);
    return runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
}

function buildManifest(repoRoot: string, options: {
    baseCommit: string;
    stagedPatch?: Buffer;
    unstagedPatch?: Buffer;
    trackedFiles?: RepairWipManifest['tracked_files'];
    untrackedFiles?: RepairWipManifest['untracked_files'];
}): RepairWipManifest {
    const preflight = writeArtifact(repoRoot, 'runtime/preflight.json', Buffer.from('{}\n', 'utf8'));
    const fullSuite = writeArtifact(repoRoot, 'runtime/full-suite.json', Buffer.from('{}\n', 'utf8'));
    const staged = writeArtifact(repoRoot, 'runtime/staged.patch', options.stagedPatch || Buffer.alloc(0));
    const unstaged = writeArtifact(repoRoot, 'runtime/unstaged.patch', options.unstagedPatch || Buffer.alloc(0));
    return {
        schema_version: 3,
        kind: 'full_suite_repair_wip',
        status: 'suspended',
        task_id: 'T-TEST',
        child_task_ids: ['T-TEST-F1', 'T-TEST-F2'],
        created_at_utc: '2026-07-31T00:00:00.000Z',
        base_commit: options.baseCommit,
        preflight_path: preflight.path,
        preflight_sha256: preflight.sha256,
        full_suite_artifact_path: fullSuite.path,
        full_suite_artifact_sha256: fullSuite.sha256,
        patches: { staged, unstaged },
        tracked_files: options.trackedFiles || [],
        untracked_files: options.untrackedFiles || [],
        unrelated_untracked_files: []
    };
}

describe('full-suite repair restore validation', () => {
    it('decodes Git quoted UTF-8 paths and rejects unsupported escapes', () => {
        assert.equal(decodeGitExtendedHeaderPath('"caf\\303\\251.txt"'), 'café.txt');
        assert.throws(
            () => decodeGitExtendedHeaderPath('"bad\\q.txt"'),
            /unsupported Git path escape \\q/u
        );
    });

    it('parses rename pairs and rejects repository traversal', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

        const valid = parsePatchExtendedPathRecords(
            repoRoot,
            Buffer.from('rename from old name.txt\nrename to new name.txt\n', 'utf8'),
            'staged patch'
        );
        assert.deepEqual(valid, {
            records: [{ paths: ['old name.txt', 'new name.txt'] }],
            violations: []
        });

        const traversal = parsePatchExtendedPathRecords(
            repoRoot,
            Buffer.from('rename from src/file.ts\nrename to ../outside.ts\n', 'utf8'),
            'staged patch'
        );
        assert.ok(
            traversal.violations.some((violation) => violation.includes('escapes repo root')),
            traversal.violations.join('\n')
        );
    });

    it('fails closed when an authenticated artifact hash is tampered', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

        const preflight = writeArtifact(repoRoot, 'runtime/preflight.json', Buffer.from('{}\n', 'utf8'));
        const fullSuite = writeArtifact(repoRoot, 'runtime/full-suite.json', Buffer.from('{}\n', 'utf8'));
        const staged = writeArtifact(repoRoot, 'runtime/staged.patch', Buffer.alloc(0));
        const unstaged = writeArtifact(repoRoot, 'runtime/unstaged.patch', Buffer.alloc(0));
        const manifest: RepairWipManifest = {
            schema_version: 3,
            kind: 'full_suite_repair_wip',
            status: 'suspended',
            task_id: 'T-TEST',
            child_task_ids: ['T-TEST-F1', 'T-TEST-F2'],
            created_at_utc: '2026-07-31T00:00:00.000Z',
            base_commit: 'deadbeef',
            preflight_path: preflight.path,
            preflight_sha256: '0'.repeat(64),
            full_suite_artifact_path: fullSuite.path,
            full_suite_artifact_sha256: fullSuite.sha256,
            patches: { staged, unstaged },
            tracked_files: [],
            untracked_files: [],
            unrelated_untracked_files: []
        };

        const result = validateManifestFileReferences(repoRoot, manifest);

        assert.deepEqual(result.patchSnapshots, {
            staged: Buffer.alloc(0),
            unstaged: Buffer.alloc(0)
        });
        assert.equal(result.violations.length, 1);
        assert.match(result.violations[0], /^preflight artifact sha256 mismatch:/u);
    });

    it('binds parsed numstat paths and rejects an unbound tracked patch', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const baseCommit = initializeRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'file.ts'), 'changed\n', 'utf8');
        runGit(repoRoot, ['add', 'src/file.ts']);
        const stagedPatch = readGit(repoRoot, ['diff', '--cached', '--binary']);
        const trackedFile = {
            path: 'src/file.ts',
            head_sha256: sha256(Buffer.from('base\n', 'utf8')),
            worktree_sha256: sha256(Buffer.from('changed\n', 'utf8')),
            staged: true,
            unstaged: false
        };
        const boundManifest = buildManifest(repoRoot, {
            baseCommit,
            stagedPatch,
            trackedFiles: [trackedFile]
        });

        const bound = validateManifestPatchBindings(repoRoot, boundManifest, {
            staged: stagedPatch,
            unstaged: Buffer.alloc(0)
        });
        assert.deepEqual(bound, {
            historyPaths: ['src/file.ts'],
            violations: []
        });

        const unbound = validateManifestPatchBindings(
            repoRoot,
            { ...boundManifest, tracked_files: [] },
            { staged: stagedPatch, unstaged: Buffer.alloc(0) }
        );
        assert.ok(
            unbound.violations.some((violation) => violation.includes('has content but no bound tracked_files entries')),
            unbound.violations.join('\n')
        );
        assert.ok(
            unbound.violations.some((violation) => violation.includes('changed paths are not bound by tracked_files')),
            unbound.violations.join('\n')
        );
    });

    it('rejects a descendant HEAD that touched a suspended WIP path', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const baseCommit = initializeRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'file.ts'), 'child\n', 'utf8');
        runGit(repoRoot, ['add', 'src/file.ts']);
        runGit(repoRoot, ['commit', '--quiet', '-m', 'child']);

        const violations = validateDescendantRestoreHead(
            repoRoot,
            { base_commit: baseCommit } as RepairWipManifest,
            ['src/file.ts']
        );

        assert.deepEqual(violations, [
            'repair child commit overlaps suspended WIP path: src/file.ts'
        ]);
    });

    it('aggregates restore inspection and rejects an existing untracked target', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const baseCommit = initializeRepo(repoRoot);
        const manifest = buildManifest(repoRoot, { baseCommit });

        const cleanInspection = inspectRestoreMutationState(repoRoot, manifest);
        assert.deepEqual(cleanInspection, {
            violations: [],
            patchSnapshots: {
                staged: Buffer.alloc(0),
                unstaged: Buffer.alloc(0)
            }
        });

        const content = Buffer.from('captured scratch\n', 'utf8');
        const artifact = writeArtifact(repoRoot, 'runtime/untracked/scratch.bin', content);
        const artifactMode = fs.statSync(path.join(repoRoot, artifact.path)).mode & 0o777;
        const entry: CapturedUntrackedFileEvidence = {
            path: 'scratch.txt',
            artifact_path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
            mode: artifactMode
        };
        fs.writeFileSync(path.join(repoRoot, entry.path), 'foreign content\n', 'utf8');

        const occupiedInspection = inspectRestoreMutationState(repoRoot, {
            ...manifest,
            untracked_files: [entry]
        });
        assert.ok(
            occupiedInspection.violations.includes('untracked restore target already exists: scratch.txt'),
            occupiedInspection.violations.join('\n')
        );
        assert.deepEqual(occupiedInspection.patchSnapshots, cleanInspection.patchSnapshots);
    });

    it('scrubs restored untracked bytes through rollback before unlinking', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const content = Buffer.from('sensitive WIP bytes\n', 'utf8');
        const targetPath = path.join(repoRoot, 'scratch.txt');
        const linkedPath = path.join(repoRoot, 'retained-hard-link.txt');
        fs.writeFileSync(targetPath, content);
        fs.linkSync(targetPath, linkedPath);
        const entry: CapturedUntrackedFileEvidence = {
            path: 'scratch.txt',
            artifact_path: 'runtime/untracked/scratch.bin',
            sha256: sha256(content),
            bytes: content.byteLength,
            mode: fs.statSync(targetPath).mode & 0o777
        };
        const emptyPatch: CapturedPatchEvidence = {
            path: 'runtime/empty.patch',
            sha256: sha256(Buffer.alloc(0)),
            bytes: 0,
            empty: true
        };

        const violations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest: {
                patches: {
                    staged: emptyPatch,
                    unstaged: emptyPatch
                }
            } as RepairWipManifest,
            patchSnapshots: {
                staged: Buffer.alloc(0),
                unstaged: Buffer.alloc(0)
            },
            stagedApplied: false,
            unstagedApplied: false,
            createdUntrackedFiles: [entry]
        });

        assert.deepEqual(violations, []);
        assert.equal(fs.existsSync(targetPath), false);
        assert.deepEqual(fs.readFileSync(linkedPath), Buffer.alloc(0));
    });

    it('reverses an applied staged patch during rollback', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restore-validation-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        initializeRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'file.ts'), 'changed\n', 'utf8');
        runGit(repoRoot, ['add', 'src/file.ts']);
        const stagedPatch = readGit(repoRoot, ['diff', '--cached', '--binary']);
        const stagedEvidence: CapturedPatchEvidence = {
            path: 'runtime/staged.patch',
            sha256: sha256(stagedPatch),
            bytes: stagedPatch.byteLength,
            empty: false
        };
        const emptyPatch: CapturedPatchEvidence = {
            path: 'runtime/unstaged.patch',
            sha256: sha256(Buffer.alloc(0)),
            bytes: 0,
            empty: true
        };

        const violations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest: {
                patches: {
                    staged: stagedEvidence,
                    unstaged: emptyPatch
                }
            } as RepairWipManifest,
            patchSnapshots: {
                staged: stagedPatch,
                unstaged: Buffer.alloc(0)
            },
            stagedApplied: true,
            unstagedApplied: false,
            createdUntrackedFiles: []
        });

        assert.deepEqual(violations, []);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'file.ts'), 'utf8'), 'base\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--cached', '--name-only']).trim(), '');
    });

    it('reports a missing authenticated patch snapshot during rollback', () => {
        const nonEmptyPatch: CapturedPatchEvidence = {
            path: 'runtime/staged.patch',
            sha256: '0'.repeat(64),
            bytes: 1,
            empty: false
        };
        const emptyPatch: CapturedPatchEvidence = {
            path: 'runtime/unstaged.patch',
            sha256: sha256(Buffer.alloc(0)),
            bytes: 0,
            empty: true
        };
        const manifest = {
            patches: {
                staged: nonEmptyPatch,
                unstaged: emptyPatch
            }
        } as RepairWipManifest;

        const violations = rollbackFullSuiteRepairRestore({
            repoRoot: '.',
            manifest,
            patchSnapshots: { staged: null, unstaged: null },
            stagedApplied: true,
            unstagedApplied: false,
            createdUntrackedFiles: []
        });

        assert.deepEqual(violations, [
            'failed to roll back staged WIP patch: validated content snapshot is unavailable.'
        ]);
    });
});
