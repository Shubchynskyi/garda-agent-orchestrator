import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    applyMaterializationStage,
    createCopyFileStage,
    createWriteTextFileStage
} from '../../../src/materialization/staged-side-effects';

describe('materialization staged side effects', () => {
    it('does not apply stages during dry-run', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-dry-'));
        try {
            const targetPath = path.join(tempDir, 'nested', 'file.txt');

            const result = applyMaterializationStage(
                createWriteTextFileStage(targetPath, 'new content'),
                { dryRun: true }
            );

            assert.equal(result.status, 'dry-run');
            assert.equal(fs.existsSync(targetPath), false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rolls back an existing file when a later operation in the same stage fails', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-rollback-'));
        try {
            const targetPath = path.join(tempDir, 'file.txt');
            fs.writeFileSync(targetPath, 'original', 'utf8');

            const stage = createWriteTextFileStage(targetPath, 'updated');
            assert.throws(() => applyMaterializationStage({
                label: 'failing-wrapper',
                apply: () => {
                    stage.apply();
                    throw new Error('simulated failure');
                },
                rollback: stage.rollback
            }), /simulated failure/);

            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('restores overwritten copy destinations on rollback', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-copy-'));
        try {
            const sourcePath = path.join(tempDir, 'source.txt');
            const targetPath = path.join(tempDir, 'target.txt');
            fs.writeFileSync(sourcePath, 'source', 'utf8');
            fs.writeFileSync(targetPath, 'target', 'utf8');

            const stage = createCopyFileStage(sourcePath, targetPath);
            stage.apply();
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'source');

            stage.rollback?.();
            assert.equal(fs.readFileSync(targetPath, 'utf8'), 'target');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not remove caller-owned empty parent directories during rollback cleanup', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stage-boundary-'));
        try {
            const ownedRoot = path.join(tempDir, 'owned-root');
            fs.mkdirSync(ownedRoot);
            const targetPath = path.join(ownedRoot, 'generated', 'file.txt');

            const stage = createWriteTextFileStage(targetPath, 'generated');
            stage.apply();
            stage.rollback?.();

            assert.equal(fs.existsSync(targetPath), false);
            assert.equal(fs.existsSync(path.dirname(targetPath)), false);
            assert.equal(fs.existsSync(ownedRoot), true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
