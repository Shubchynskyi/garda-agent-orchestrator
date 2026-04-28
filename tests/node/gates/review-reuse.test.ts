import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    computeCodeReviewScopeFingerprint,
    computeReviewRelevantScopeFingerprint
} from '../../../src/gates/review-reuse';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

describe('gates/review-reuse', () => {
    it('fingerprints staged scope from the index instead of the dirty working tree', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-staged-scope-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "alpha";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const preflight = {
                detection_source: 'git_staged_only',
                changed_files: ['src/reviewed.ts']
            };
            const stagedAlphaCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedAlphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "bravo";\n', 'utf8');
            const dirtyWorktreeCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const dirtyWorktreeReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.equal(dirtyWorktreeCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.equal(dirtyWorktreeReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);

            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const stagedBravoCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedBravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.notEqual(stagedBravoCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.notEqual(stagedBravoReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
