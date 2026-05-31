import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import { normalizePath } from '../../../../src/gates/helpers';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    prepareCurrentReviewPhase,
    seedInitAnswers,
    seedTaskQueue,
    writePreflight
} from './gate-test-helpers';

describe('gate build-review-context CLI flow binding', () => {
    it('preserves custom review-context output path wiring', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-custom-output';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        const outputPath = path.join(getReviewsRoot(repoRoot), 'custom', `${taskId}-context.json`);
        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath
        });

        assert.equal(result.outputPath, normalizePath(outputPath));
        assert.equal(fs.existsSync(outputPath), true);
        assert.equal(result.outputLines.includes(`ReviewContextPath: ${normalizePath(outputPath)}`), true);
        assert.equal(result.outputLines.includes(`OutputPath: ${normalizePath(outputPath)}`), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for missing preflight path before lifecycle work', async () => {
        const repoRoot = createTempRepo();
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '2',
                preflightPath: 'garda-agent-orchestrator/runtime/reviews/missing-preflight.json'
            }),
            /Path not found/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for invalid depth at the CLI binding boundary', async () => {
        const repoRoot = createTempRepo();
        const preflightPath = writePreflight(repoRoot, 'T-review-context-cli-binding-invalid-depth');
        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'code',
                depth: '4',
                preflightPath
            }),
            /Depth must be an integer between 1 and 3/
        );
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed for unsupported review type while preserving path resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-review-context-cli-binding-invalid-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 7;\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');

        await assert.rejects(
            () => runBuildReviewContextCommand({
                repoRoot,
                reviewType: 'unknown-review-type',
                depth: '2',
                preflightPath
            }),
            /review type|Review type|unknown-review-type/i
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
