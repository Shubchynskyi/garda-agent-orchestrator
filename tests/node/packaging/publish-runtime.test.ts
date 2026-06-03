import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        const buildScriptPath = path.join(current, 'scripts', 'node-foundation', 'build.ts');
        const packageJsonPath = path.join(current, 'package.json');
        if (fs.existsSync(buildScriptPath) && fs.existsSync(packageJsonPath)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

function loadPackageSurfaceItems(repoRoot: string): readonly string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = Array.from<string>((pkgJson.files || []) as string[]);
    if (!items.includes('package.json')) {
        items.push('package.json');
    }
    return Object.freeze(items.sort());
}

const PACKAGE_SURFACE_ITEMS = loadPackageSurfaceItems(findRepoRoot(__dirname));

function loadBuildFixtureItems(repoRoot: string): readonly string[] {
    const items = new Set<string>(loadPackageSurfaceItems(repoRoot));
    items.delete('dist');
    items.delete('bin');
    items.add('scripts/node-foundation');
    items.add('tsconfig.build.json');
    items.add('tsconfig.scripts.json');
    return Object.freeze(Array.from(items).sort());
}

function copyPathSet(sourceRoot: string, targetRoot: string, relativePaths: readonly string[]): void {
    fs.mkdirSync(targetRoot, { recursive: true });
    for (const relativePath of relativePaths) {
        fs.cpSync(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath), { recursive: true });
    }
}

function copyPublishedPackageSurface(sourceRoot: string, packageRoot: string) {
    copyPathSet(sourceRoot, packageRoot, PACKAGE_SURFACE_ITEMS);
}

function copyBuildFixture(repoRoot: string, fixtureRoot: string) {
    copyPathSet(repoRoot, fixtureRoot, loadBuildFixtureItems(repoRoot));

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }
}

function writeTextFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildEnvWithoutBundleName(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.GARDA_BUNDLE_NAME;
    return env;
}

function syncGeneratedCliEntrypoint(repoRoot: string): void {
    const compiledCliPath = path.join(repoRoot, 'dist', 'src', 'bin', 'garda.js');
    if (!fs.existsSync(compiledCliPath)) {
        throw new Error(`compiled CLI launcher not found: ${compiledCliPath}`);
    }

    const repoCliPath = path.join(repoRoot, 'bin', 'garda.js');
    fs.mkdirSync(path.dirname(repoCliPath), { recursive: true });
    fs.copyFileSync(compiledCliPath, repoCliPath);
}

function buildPublishRuntimeInRepo(repoRoot: string): void {
    const result = childProcess.spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs'),
        'build.js',
        'publish-runtime'
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });

    if (result.status !== 0) {
        throw new Error(`publish runtime build failed:\n${result.stderr || result.stdout}`);
    }

    syncGeneratedCliEntrypoint(repoRoot);
}

test('published runtime works when the package is executed from node_modules', () => {
    const repoRoot = getRepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-publish-runtime-'));
    const fixtureRoot = path.join(tempRoot, 'package-fixture');
    const packageRoot = path.join(tempRoot, 'node_modules', 'garda-agent-orchestrator');
    const workspaceRoot = path.join(tempRoot, 'workspace');

    try {
        copyBuildFixture(repoRoot, fixtureRoot);
        buildPublishRuntimeInRepo(fixtureRoot);
        assert.ok(fs.existsSync(path.join(fixtureRoot, 'dist', 'src', 'index.js')));
        assert.ok(fs.existsSync(path.join(fixtureRoot, 'dist', 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-ru.json')));

        copyPublishedPackageSurface(fixtureRoot, packageRoot);
        fs.mkdirSync(workspaceRoot, { recursive: true });

        const result = childProcess.spawnSync(
            process.execPath,
            [path.join(packageRoot, 'bin', 'garda.js'), 'status', '--target-root', workspaceRoot],
            {
                cwd: workspaceRoot,
                encoding: 'utf8',
                env: buildEnvWithoutBundleName()
            }
        );

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /GARDA_STATUS/);
        assert.doesNotMatch(
            `${result.stdout}\n${result.stderr}`,
            /Stripping types is currently unsupported for files under node_modules/i
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('published runtime setup stays in agent handoff state and uninstall restores legacy files', () => {
    const repoRoot = getRepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-publish-lifecycle-'));
    const fixtureRoot = path.join(tempRoot, 'package-fixture');
    const packageRoot = path.join(tempRoot, 'node_modules', 'garda-agent-orchestrator');
    const workspaceRoot = path.join(tempRoot, 'workspace');

    const legacyFiles = new Map([
        ['AGENTS.md', '# Legacy AGENTS\n\nUser-owned instructions.\n'],
        ['TASK.md', '# Legacy TASK\n\n- user backlog\n'],
        ['.gitignore', 'node_modules/\n.custom-cache/\n'],
        ['.qwen/settings.json', JSON.stringify({
            context: { fileName: ['README.md'] },
            userSetting: true
        }, null, 2)]
    ]);

    try {
        copyBuildFixture(repoRoot, fixtureRoot);
        buildPublishRuntimeInRepo(fixtureRoot);
        copyPublishedPackageSurface(fixtureRoot, packageRoot);
        fs.mkdirSync(workspaceRoot, { recursive: true });
        for (const [relativePath, content] of legacyFiles) {
            writeTextFile(path.join(workspaceRoot, relativePath), content);
        }

        const setupResult = childProcess.spawnSync(
            process.execPath,
            [
                path.join(packageRoot, 'bin', 'garda.js'),
                'setup',
                '--target-root', workspaceRoot,
                '--no-prompt',
                '--assistant-language', 'English',
                '--assistant-brevity', 'concise',
                '--source-of-truth', 'Codex',
                '--enforce-no-auto-commit', 'false',
                '--claude-orchestrator-full-access', 'false',
                '--token-economy-enabled', 'true'
            ],
            {
                cwd: workspaceRoot,
                encoding: 'utf8',
                env: buildEnvWithoutBundleName()
            }
        );

        assert.equal(setupResult.status, 0, setupResult.stderr || setupResult.stdout);
        assert.match(setupResult.stdout, /Primary setup finished\. Next stage: agent initialization\./);
        assert.doesNotMatch(setupResult.stdout, /Workspace is ready\./);
        assert.match(setupResult.stdout, /Give your agent:/);

        const initAnswersPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
        const initAnswers = readJson(initAnswersPath);
        assert.equal(initAnswers.SourceOfTruth, 'Codex');
        assert.equal(initAnswers.CollectedVia, 'CLI_NONINTERACTIVE');
        assert.equal(initAnswers.ActiveAgentFiles, 'AGENTS.md');

        assert.ok(fs.existsSync(path.join(workspaceRoot, 'AGENTS.md')));
        assert.ok(!fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md')));

        const uninstallResult = childProcess.spawnSync(
            process.execPath,
            [path.join(packageRoot, 'bin', 'garda.js'), 'uninstall', '--target-root', workspaceRoot],
            {
                cwd: workspaceRoot,
                encoding: 'utf8',
                env: buildEnvWithoutBundleName()
            }
        );

        assert.equal(uninstallResult.status, 0, uninstallResult.stderr || uninstallResult.stdout);
        assert.ok(!fs.existsSync(path.join(workspaceRoot, 'garda-agent-orchestrator')));

        // .agents/ router directory must be removed when only orchestrator-managed content remained
        assert.ok(!fs.existsSync(path.join(workspaceRoot, '.agents')),
            'Expected .agents/ directory to be removed after uninstall');

        for (const [relativePath, originalContent] of legacyFiles) {
            const restoredPath = path.join(workspaceRoot, relativePath);
            assert.ok(fs.existsSync(restoredPath), `Expected restored file: ${relativePath}`);

            if (relativePath === '.gitignore') {
                // Restored .gitignore must contain original user content
                const restoredContent = fs.readFileSync(restoredPath, 'utf8');
                assert.ok(restoredContent.includes('node_modules/'),
                    'Restored .gitignore must contain original user entries');
                assert.ok(restoredContent.includes('.custom-cache/'),
                    'Restored .gitignore must contain original user entries');
                // Must also include uninstall-backup ignore entries
                assert.ok(restoredContent.includes('garda-agent-orchestrator-uninstall-backups/'),
                    'Restored .gitignore must ignore uninstall backup directory');
                assert.ok(!restoredContent.includes('garda-agent-orchestrator-uninstall-backups/**'),
                    'Redundant wildcard entry must not be present');
                assert.ok(restoredContent.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                    'Explanatory comment for uninstall backups must be present');
            } else {
                assert.equal(fs.readFileSync(restoredPath, 'utf8'), originalContent);
            }
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
