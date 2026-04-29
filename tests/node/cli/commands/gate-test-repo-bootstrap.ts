/**
 * Test helpers: temporary repo creation, git bootstrap, and path utilities.
 *
 * Extracted from gate-test-helpers.ts to isolate repo-scaffold concerns
 * from rule/evidence seeding and CLI capture.  All exports are test-only.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';


export function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

export function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}


export function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}


export function createTempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gates-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    return root;
}

export function createWindowsBatchNodeFixture(
    scriptSource: string,
    options: { forwardArgs?: boolean } = {}
): { batchPath: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-gates-'));
    const jsPath = path.join(root, 'payload.js');
    const batchPath = path.join(root, 'run-fixture.cmd');
    const forwardArgs = options.forwardArgs ? ' %*' : '';
    fs.writeFileSync(jsPath, `${scriptSource}\n`, 'utf8');
    fs.writeFileSync(batchPath, `@echo off\r\n"${process.execPath}" "${jsPath}"${forwardArgs}\r\n`, 'utf8');
    return {
        batchPath,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

export function createDependentValidationFixture(): {
    repoRoot: string;
    consumerPath: string;
    manifestPath: string;
    sourcePath: string;
    lockPath: string;
    nestedCwd: string;
    cleanup: () => void;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-validation-chain-'));
    const sourcePath = path.join(repoRoot, 'src', 'feature.ts');
    const consumerPath = path.join(repoRoot, '.node-build', 'tests', 'node', 'sample.test.js');
    const manifestPath = path.join(repoRoot, '.node-build', 'node-foundation-manifest.json');
    const lockPath = path.join(repoRoot, '.node-build.lock');
    const nestedCwd = path.join(repoRoot, 'packages', 'feature');

    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'scripts', 'node-foundation'), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(sourcePath, 'export const feature = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'sample.test.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'node-foundation', 'helper.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(consumerPath, 'import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("sample", () => { assert.equal(1, 1); });\n', 'utf8');

    return {
        repoRoot,
        consumerPath,
        manifestPath,
        sourcePath,
        lockPath,
        nestedCwd,
        cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true })
    };
}


export function writeNodeFoundationManifest(manifestPath: string): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        sourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
        files: ['tests/node/sample.test.js']
    }, null, 2) + '\n', 'utf8');
}


export function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8'
    });
    if (result.error) {
        throw result.error;
    }
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`
    );
    return result;
}

export function initializeGitRepo(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'test: baseline']);
}


export function ageFixturePath(filePath: string, ageMs: number): void {
    const agedDate = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, agedDate, agedDate);
}
