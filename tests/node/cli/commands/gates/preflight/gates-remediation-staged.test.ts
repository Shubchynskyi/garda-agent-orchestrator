import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    runGit,
    backdateFileMtime
} from '../../gate-test-repo-bootstrap';

import {
    seedTaskQueue,
    seedInitAnswers,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    loadTaskEntryRulePack,
    runClassifyChangeCommand
} from '../../gate-test-seed-helpers';

describe('failed-review remediation refresh with staged-mode', { concurrency: false }, () => {
    it('allows refreshing preflight scope using --use-staged during remediation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-486-staged-remediation';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        // Seed AGENTS.md and commit it to baseline
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        // 1. Initial implementation
        fs.mkdirSync(path.dirname(appPath), { recursive: true });
        fs.writeFileSync(appPath, 'console.log("v1");\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        runGit(repoRoot, ['commit', '-m', 'feat: v1']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Test staged remediation'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        // 2. Initial preflight (git_auto)
        fs.writeFileSync(appPath, 'console.log("v2");\n', 'utf8');
        backdateFileMtime(appPath);
        
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'v2 implementation',
            outputPath: preflightPath,
            emitMetrics: false
        });

        const preflightV1 = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(preflightV1.detection_source, 'git_auto');
        assert.deepEqual(preflightV1.changed_files, ['src/app.ts']);

        // 3. Simulate remediation fix (staged)
        // Stage the fix, and have some other dirty file
        fs.writeFileSync(appPath, 'console.log("v3 fix");\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        
        const otherFile = path.join(repoRoot, 'src', 'other.ts');
        fs.writeFileSync(otherFile, '// unrelated dirty file\n', 'utf8');

        // 4. Refresh preflight using --use-staged
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'v3 remediation fix',
            useStaged: true,
            outputPath: preflightPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const preflightV2 = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.equal(preflightV2.detection_source, 'git_staged_only');
        assert.deepEqual(preflightV2.changed_files, ['src/app.ts']);
        
        // Ensure other.ts (which is dirty but NOT staged) is not in changed_files
        assert.ok(!preflightV2.changed_files.includes('src/other.ts'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
