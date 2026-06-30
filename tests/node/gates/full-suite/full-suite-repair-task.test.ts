import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    materializeFullSuiteRepairTask,
    readFullSuiteRepairTaskMaterializationEvidence,
    restoreFullSuiteRepairWip
} from '../../../../src/gates/full-suite/full-suite-repair-task';

const TASK_ID = 'T-FULL-SUITE-REPAIR';
const CHILD_TASK_ID = `${TASK_ID}-F1`;

const tempRoots: string[] = [];

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeForArtifact(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function normalizeNewlines(value: string): string {
    return value.replace(/\r\n/g, '\n');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function seedTaskQueue(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/full-suite | Parent repair task | gpt-5.5 | 2026-06-30 | strict | Parent task. |`,
        ''
    ].join('\n'), 'utf8');
}

function seedRepairArtifacts(repoRoot: string): { preflightPath: string; fullSuitePath: string } {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const fullSuitePath = path.join(reviewsRoot, `${TASK_ID}-full-suite-validation.json`);
    writeJson(preflightPath, {
        task_id: TASK_ID,
        status: 'PASSED',
        required_reviews: { code: true, test: true },
        changed_files: ['src/app.ts']
    });
    writeJson(fullSuitePath, {
        task_id: TASK_ID,
        status: 'FAILED',
        enabled: true,
        command: 'npm test',
        exit_code: 1,
        timed_out: true,
        timeout_policy: {
            timeout_blocker: true,
            timeout_retry_count: 1,
            max_attempts: 2,
            attempts: [
                { attempt: 1, exit_code: 1, timed_out: true },
                { attempt: 2, exit_code: 1, timed_out: true }
            ],
            attempts_exhausted: true,
            warning_only_continuation: false,
            repair_task_proposal: {
                suggested_task_id: CHILD_TASK_ID,
                title: 'Fix full-suite timeout blocker',
                area: 'workflow/full-suite-timeout',
                rationale: 'Full-suite validation timed out after configured retries.'
            }
        },
        output_artifact_path: normalizeForArtifact(path.join(reviewsRoot, `${TASK_ID}-full-suite-output.log`))
    });
    return { preflightPath, fullSuitePath };
}

function makeRepo(): { repoRoot: string; preflightPath: string; fullSuitePath: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-full-suite-repair-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    seedTaskQueue(repoRoot);

    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['add', '.gitignore', 'README.md', 'src/app.ts']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return { repoRoot, ...seedRepairArtifacts(repoRoot) };
}

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function restoreMaterializedWip(params: {
    repoRoot: string;
    fullSuitePath: string;
    manifestPath: string;
    childTaskId?: string | null;
    dryRun?: boolean;
}) {
    return restoreFullSuiteRepairWip({
        repoRoot: params.repoRoot,
        taskId: TASK_ID,
        fullSuiteArtifactPath: params.fullSuitePath,
        manifestPath: params.manifestPath,
        childTaskId: params.childTaskId === undefined ? CHILD_TASK_ID : params.childTaskId,
        dryRun: params.dryRun
    });
}

function setTaskStatus(repoRoot: string, taskId: string, nextStatus: string): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    let replaced = false;
    const lines = content.split('\n').map((line) => {
        if (!line.startsWith(`| ${taskId} |`)) {
            return line;
        }
        const cells = line.split('|');
        cells[2] = ` ${nextStatus} `;
        replaced = true;
        return cells.join('|');
    });
    assert.equal(replaced, true, `expected TASK.md row for ${taskId}`);
    fs.writeFileSync(taskPath, lines.join('\n'), 'utf8');
}

function markRepairChildDone(repoRoot: string): void {
    setTaskStatus(repoRoot, CHILD_TASK_ID, 'DONE');
}

function refreshMaterializationManifestSha(repoRoot: string, manifestPath: string): void {
    const artifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-full-suite-repair-task.json`
    );
    const artifact = readJson(artifactPath);
    artifact.wip_manifest_sha256 = fileSha256(manifestPath);
    writeJson(artifactPath, artifact);
}

describe('full-suite repair task materialization', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('suspends staged, unstaged, and task-owned ignored scratch, then restores them', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(appPath, 'export const value = 3;\n', 'utf8');

        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        const reviewEvidencePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-extra-review-evidence.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.mkdirSync(path.dirname(reviewEvidencePath), { recursive: true });
        fs.writeFileSync(scratchPath, 'scratch parent WIP\n', 'utf8');
        fs.writeFileSync(reviewEvidencePath, 'must remain gate evidence\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.ok(materialized.wip_manifest_path);
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
        assert.equal(fs.existsSync(scratchPath), false);
        assert.equal(fs.existsSync(reviewEvidencePath), true, 'review evidence must not be captured as WIP');

        const manifest = readJson(materialized.wip_manifest_path || '');
        const untrackedPaths = (manifest.untracked_files as Array<Record<string, unknown>>).map((entry) => entry.path);
        assert.deepEqual(untrackedPaths, ['garda-agent-orchestrator/runtime/tmp/T-FULL-SUITE-REPAIR-scratch.log']);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${CHILD_TASK_ID} | TODO |`));
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*SPLIT_REQUIRED .*\\|`));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 3;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.match(runGit(repoRoot, ['diff', '--', 'src/app.ts']), /[-]export const value = 2;[\s\S]*[+]export const value = 3;/);
        assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'scratch parent WIP\n');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(`\\| ${TASK_ID} \\| .*IN_PROGRESS .*\\|`));
    });

    it('blocks restore before the linked repair child is DONE', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes(`repair child ${CHILD_TASK_ID} must be DONE`)));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks materialization when tracked changes include files outside the preflight scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n\nunrelated\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.equal(materialized.split_required_artifact_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('tracked changes outside current preflight scope: README.md')));
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), 'README.md');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), 'src/app.ts');
        assert.ok(!fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${CHILD_TASK_ID} | TODO |`));
    });

    it('blocks materialization when unrelated visible untracked files would dirty the repair scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'unrelated-notes.txt'), 'operator scratch\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('unrelated untracked files would keep repair scope dirty: unrelated-notes.txt')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'unrelated-notes.txt'), 'utf8'), 'operator scratch\n');
        assert.equal(runGit(repoRoot, ['status', '--short', '--untracked-files=all']).includes('?? unrelated-notes.txt'), true);
        assert.ok(!fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${CHILD_TASK_ID} | TODO |`));
    });

    it('blocks task-id untracked files outside the captured runtime tmp and preflight scopes', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'scratch', TASK_ID, 'notes.txt');
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'operator scratch outside capture roots\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('scratch/T-FULL-SUITE-REPAIR/notes.txt')));
        assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'operator scratch outside capture roots\n');
        assert.equal(runGit(repoRoot, ['status', '--short', '--untracked-files=all']).includes('?? scratch/T-FULL-SUITE-REPAIR/notes.txt'), true);
    });

    it('does not suspend WIP when durable repair task materialization fails', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        fs.rmSync(path.join(repoRoot, 'TASK.md'), { force: true });

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('TASK.md repair child materialization failed: task_file_missing')));
        assert.equal(fs.readFileSync(appPath, 'utf8'), 'export const value = 2;\n');
        assert.match(runGit(repoRoot, ['diff', '--cached', '--', 'src/app.ts']), /\+export const value = 2;/);
        assert.equal(fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'wip')), false);
    });

    it('suspends and restores visible untracked files inside the preflight scope', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const preflight = readJson(preflightPath);
        preflight.changed_files = ['src/app.ts', 'src/new-helper.ts'];
        writeJson(preflightPath, preflight);
        const newHelperPath = path.join(repoRoot, 'src', 'new-helper.ts');
        fs.writeFileSync(newHelperPath, 'export const helper = true;\n', 'utf8');

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.equal(fs.existsSync(newHelperPath), false);
        const manifest = readJson(materialized.wip_manifest_path || '');
        const untrackedPaths = (manifest.untracked_files as Array<Record<string, unknown>>).map((entry) => entry.path);
        assert.ok(untrackedPaths.includes('src/new-helper.ts'));
        markRepairChildDone(repoRoot);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
        assert.equal(fs.readFileSync(newHelperPath, 'utf8'), 'export const helper = true;\n');
    });

    it('does not capture unrelated ignored runtime trees while suspending scoped WIP', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const ignoredCacheRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'cache', 'bulk');
        fs.mkdirSync(ignoredCacheRoot, { recursive: true });
        for (let index = 0; index < 300; index += 1) {
            fs.writeFileSync(path.join(ignoredCacheRoot, `cache-${index}.log`), `cache ${index}\n`, 'utf8');
        }

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const manifest = readJson(materialized.wip_manifest_path || '');
        assert.deepEqual(manifest.untracked_files, []);
        assert.deepEqual(manifest.unrelated_untracked_files, []);
        assert.equal(fs.existsSync(path.join(ignoredCacheRoot, 'cache-299.log')), true);
    });

    it('blocks repair proposals that would inject Markdown table rows', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const originalTaskQueue = fs.readFileSync(taskPath, 'utf8');
        const fullSuiteArtifact = readJson(fullSuitePath);
        const timeoutPolicy = fullSuiteArtifact.timeout_policy as Record<string, unknown>;
        const proposal = timeoutPolicy.repair_task_proposal as Record<string, unknown>;
        proposal.suggested_task_id = `${TASK_ID}-F1 | DONE`;
        proposal.title = 'Injected\nrow';
        proposal.area = 'workflow/full-suite-timeout | injected';
        writeJson(fullSuitePath, fullSuiteArtifact);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        assert.equal(materialized.status, 'BLOCKED');
        assert.equal(materialized.wip_manifest_path, null);
        assert.ok(materialized.violations.some((violation) => violation.includes('suggested_task_id must match')));
        assert.ok(materialized.violations.some((violation) => violation.includes('title must not contain')));
        assert.ok(materialized.violations.some((violation) => violation.includes('area must not contain')));
        assert.equal(fs.readFileSync(taskPath, 'utf8'), originalTaskQueue);
    });

    it('blocks restore when the base commit changed after suspension', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n\nadvanced\n', 'utf8');
        runGit(repoRoot, ['add', 'README.md']);
        runGit(repoRoot, ['commit', '-m', 'advance base']);

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('stale base commit')));
    });

    it('blocks restore when tracked workspace changes would conflict with the suspended WIP', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 99;\n', 'utf8');
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('unstaged tracked changes exist')));
    });

    it('blocks restore when a captured patch artifact hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const manifest = readJson(materialized.wip_manifest_path || '');
        const patches = manifest.patches as Record<string, Record<string, unknown>>;
        fs.writeFileSync(String(patches.staged.path), 'tampered patch\n', 'utf8');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('staged patch sha256 mismatch')));
    });

    it('blocks restore when a captured untracked artifact hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'scratch parent WIP\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const manifest = readJson(materialized.wip_manifest_path || '');
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        fs.writeFileSync(String(untrackedFiles[0].artifact_path), 'tampered scratch\n', 'utf8');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('untracked artifact garda-agent-orchestrator/runtime/tmp/T-FULL-SUITE-REPAIR-scratch.log sha256 mismatch')));
    });

    it('restores untracked files from repo-root-resolved artifact paths', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const scratchPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-scratch.log`);
        fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
        fs.writeFileSync(scratchPath, 'real scratch parent WIP\n', 'utf8');
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);

        const manifestPath = materialized.wip_manifest_path || '';
        const manifest = readJson(manifestPath);
        const untrackedFiles = manifest.untracked_files as Array<Record<string, unknown>>;
        const relativeArtifactPath = normalizeForArtifact(path.relative(repoRoot, String(untrackedFiles[0].artifact_path)));
        untrackedFiles[0].artifact_path = relativeArtifactPath;
        writeJson(manifestPath, manifest);
        refreshMaterializationManifestSha(repoRoot, manifestPath);

        const previousCwd = process.cwd();
        const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fake-cwd-'));
        tempRoots.push(fakeCwd);
        const fakeArtifactPath = path.join(fakeCwd, relativeArtifactPath);
        fs.mkdirSync(path.dirname(fakeArtifactPath), { recursive: true });
        fs.writeFileSync(fakeArtifactPath, 'forged cwd scratch\n', 'utf8');
        try {
            process.chdir(fakeCwd);
            const restored = restoreMaterializedWip({
                repoRoot,
                fullSuitePath,
                manifestPath
            });

            assert.equal(restored.status, 'RESTORED', restored.output_lines.join('\n'));
            assert.equal(fs.readFileSync(scratchPath, 'utf8'), 'real scratch parent WIP\n');
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('rejects materialization evidence when the WIP manifest hash changed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.ok(materialized.wip_manifest_path);

        const manifest = readJson(materialized.wip_manifest_path || '');
        manifest.status = 'suspended';
        manifest.tampered = true;
        writeJson(materialized.wip_manifest_path || '', manifest);

        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'),
            taskId: TASK_ID,
            fullSuiteArtifactPath: fullSuitePath,
            childTaskId: CHILD_TASK_ID
        });

        assert.equal(evidence.materialized, false);
        assert.equal(evidence.reason, 'full-suite repair WIP manifest sha256 mismatch');
    });

    it('blocks restore before applying WIP when the parent row cannot be resumed', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        markRepairChildDone(repoRoot);
        setTaskStatus(repoRoot, TASK_ID, 'TODO');

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: materialized.wip_manifest_path || ''
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.deepEqual(restored.restored_files, []);
        assert.ok(restored.violations.some((violation) => violation.includes('parent status sync precheck failed: blocked_status')));
        assert.equal(normalizeNewlines(fs.readFileSync(appPath, 'utf8')), 'export const value = 1;\n');
        assert.equal(runGit(repoRoot, ['diff', '--name-only']).trim(), '');
        assert.equal(runGit(repoRoot, ['diff', '--name-only', '--cached']).trim(), '');
    });

    it('blocks restore when the requested manifest is not bound by current materialization evidence', () => {
        const { repoRoot, preflightPath, fullSuitePath } = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));

        const forgedManifestPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            TASK_ID,
            'full-suite-repair',
            'forged',
            'manifest.json'
        );
        writeJson(forgedManifestPath, readJson(materialized.wip_manifest_path || ''));

        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: forgedManifestPath
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('not the current materialized full-suite repair WIP manifest')));
    });

    it('blocks restore when the requested manifest path escapes the repo root', () => {
        const { repoRoot, fullSuitePath } = makeRepo();
        const restored = restoreMaterializedWip({
            repoRoot,
            fullSuitePath,
            manifestPath: '../outside-manifest.json'
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('ManifestPath escapes repo root')));
    });
});
