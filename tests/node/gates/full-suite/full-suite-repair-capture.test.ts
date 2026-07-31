import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    findOutOfScopeTrackedChanges,
    readVerifiedCaptureFile,
    writeExclusiveCaptureFile
} from '../../../../src/gates/full-suite/full-suite-repair-capture';

function removeTempRoot(rootPath: string): void {
    fs.rmSync(rootPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50
    });
}

describe('full-suite repair capture boundary', () => {
    it('reports tracked paths outside the authorized preflight scope', () => {
        const trackedChanges = {
            staged: new Set(['README.md', 'src/app.ts']),
            unstaged: new Set(['src/app.ts']),
            all: ['README.md', 'src/app.ts']
        };

        assert.deepEqual(
            findOutOfScopeTrackedChanges(trackedChanges, new Set(['src/app.ts'])),
            ['README.md']
        );
    });

    it('rejects a captured file replaced after exclusive creation', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-capture-'));
        context.after(() => removeTempRoot(repoRoot));
        const capturedPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            'T-CAPTURE',
            'full-suite-repair',
            '20260731T000000000Z',
            'staged.patch'
        );
        const originalContent = Buffer.from('original patch\n', 'utf8');
        const snapshot = writeExclusiveCaptureFile(
            repoRoot,
            capturedPath,
            originalContent,
            'captured staged WIP patch'
        );
        fs.unlinkSync(capturedPath);
        fs.writeFileSync(capturedPath, 'replacement patch with different identity\n', 'utf8');

        assert.throws(
            () => readVerifiedCaptureFile({
                repoRoot,
                filePath: capturedPath,
                label: 'captured staged WIP patch',
                expectedSha256: createHash('sha256').update(originalContent).digest('hex'),
                expectedBytes: originalContent.byteLength,
                expectedIdentity: snapshot.identity
            }),
            /captured staged WIP patch changed after exclusive creation/u
        );
    });
});
