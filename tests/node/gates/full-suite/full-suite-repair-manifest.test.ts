import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertSingleLinkIdentity,
    parseRepairWipManifest,
    validatePhysicalRepoContainment
} from '../../../../src/gates/full-suite/full-suite-repair-manifest';

function removeTempRoot(rootPath: string): void {
    fs.rmSync(rootPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

describe('full-suite repair manifest boundary', () => {
    it('rejects malformed manifest fields without constructing a restore manifest', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-manifest-'));
        context.after(() => removeTempRoot(repoRoot));
        const result = parseRepairWipManifest(
            repoRoot,
            path.join(repoRoot, 'manifest.json'),
            {
                kind: 'full_suite_repair_wip',
                schema_version: -1,
                status: 'captured',
                task_id: ' T-930-1-2',
                child_task_id: '',
                created_at_utc: 'not-a-timestamp',
                preflight_path: '../preflight.json',
                full_suite_artifact_path: '-full-suite.json',
                preflight_sha256: 'bad',
                full_suite_artifact_sha256: 'bad',
                base_commit: 'bad',
                patches: {
                    staged: {
                        path: '-staged.patch',
                        sha256: 'bad',
                        bytes: -1,
                        empty: 'no'
                    },
                    unstaged: {
                        path: '',
                        sha256: 'bad',
                        bytes: Number.NaN,
                        empty: null
                    }
                },
                tracked_files: [{
                    path: '../tracked.ts',
                    staged: false,
                    unstaged: false,
                    head_sha256: null,
                    worktree_sha256: null
                }],
                untracked_files: [{
                    path: '../untracked.ts',
                    artifact_path: '-artifact',
                    sha256: 'bad',
                    bytes: -1,
                    mode: 0o1000
                }],
                unrelated_untracked_files: ['../unrelated.txt']
            }
        );

        assert.equal(result.manifest, null);
        assert.ok(result.violations.includes('WIP manifest schema_version must be 2.'));
        assert.ok(result.violations.includes('WIP manifest status must be suspended.'));
        assert.ok(result.violations.includes('WIP manifest task_id must be a non-empty string.'));
        assert.ok(result.violations.includes('WIP manifest child_task_id must be a non-empty string.'));
        assert.ok(result.violations.includes(
            'WIP manifest created_at_utc must be a canonical ISO-8601 UTC timestamp.'
        ));
        assert.ok(result.violations.includes(
            'WIP manifest tracked_files[0] must belong to at least one captured patch.'
        ));
        assert.ok(result.violations.includes(
            'WIP manifest tracked_files[0] cannot have both head_sha256 and worktree_sha256 set to null.'
        ));
        assert.ok(result.violations.includes(
            'WIP manifest untracked_files[0].mode must be an integer between 0 and 0777.'
        ));
    });

    it('rejects a symbolic-link or junction component with the existing containment diagnostic', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-containment-'));
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-external-'));
        context.after(() => {
            removeTempRoot(repoRoot);
            removeTempRoot(externalRoot);
        });
        const linkPath = path.join(repoRoot, 'linked');
        fs.symlinkSync(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

        assert.deepEqual(
            validatePhysicalRepoContainment(repoRoot, path.join(linkPath, 'artifact.patch'), 'manifest artifact'),
            [`manifest artifact traverses a symbolic-link or junction component: ${linkPath.replace(/\\/gu, '/')}`]
        );
    });

    it('rejects a regular file with an additional hard link', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-hardlink-'));
        context.after(() => removeTempRoot(repoRoot));
        const artifactPath = path.join(repoRoot, 'artifact.patch');
        const hardLinkPath = path.join(repoRoot, 'artifact-copy.patch');
        fs.writeFileSync(artifactPath, 'patch\n', 'utf8');
        try {
            fs.linkSync(artifactPath, hardLinkPath);
        } catch (error: unknown) {
            context.skip(`hard links unavailable: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        assert.throws(
            () => assertSingleLinkIdentity(fs.statSync(artifactPath), 'manifest artifact'),
            new Error('manifest artifact must not have additional hard links.')
        );
    });
});
