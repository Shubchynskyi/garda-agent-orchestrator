import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getReviewArtifactLockPath,
    writeReviewArtifactJson,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review-artifacts';

function listTempArtifacts(directoryPath: string): string[] {
    return fs.readdirSync(directoryPath).filter((entry) => entry.includes('.tmp-'));
}

test('writeReviewArtifactJson writes JSON and cleans up the transient lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-001-task-mode.json');

    writeReviewArtifactJson(artifactPath, {
        task_id: 'T-001',
        status: 'PASSED'
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
        task_id: 'T-001',
        status: 'PASSED'
    });
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactText replaces existing content without leaving temp files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-002-review-output.log');
    fs.writeFileSync(artifactPath, 'old content\n', 'utf8');

    writeReviewArtifactText(artifactPath, 'new content\n');

    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'new content\n');
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactJson fails when a live review-artifact lock already exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-003-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');

    assert.throws(
        () => writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-003' },
            { lockTimeoutMs: 75, lockRetryMs: 10 }
        ),
        /Timed out acquiring file lock/
    );
    assert.equal(fs.existsSync(artifactPath), false);

    fs.rmSync(tempDir, { recursive: true, force: true });
});
