import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isTaskOwnedReviewTempPath } from '../../../../src/cli/commands/gates-artifacts';

describe('cli/commands/gates-artifacts', () => {
    it('accepts regular task-owned review temp paths', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-temp-owned-'));
        try {
            const candidatePath = path.join(repoRoot, '.review-temp', 'T-265-safe', 'code', 'reviewer-launch.json');
            fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
            fs.writeFileSync(candidatePath, '{}\n', 'utf8');

            assert.equal(isTaskOwnedReviewTempPath(repoRoot, 'T-265-safe', candidatePath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects task-owned review temp paths that escape through symlinked directories', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-temp-link-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-temp-outside-'));
        try {
            const taskRoot = path.join(repoRoot, '.review-temp', 'T-265-link');
            fs.mkdirSync(taskRoot, { recursive: true });
            fs.writeFileSync(path.join(outsideRoot, 'reviewer-launch.json'), '{}\n', 'utf8');
            const linkedDirPath = path.join(taskRoot, 'code');
            try {
                fs.symlinkSync(outsideRoot, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const candidatePath = path.join(linkedDirPath, 'reviewer-launch.json');

            assert.equal(isTaskOwnedReviewTempPath(repoRoot, 'T-265-link', candidatePath), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });
});
