import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

const RETRYABLE_WINDOWS_CLEANUP_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const SPAWN_OUTPUT_TAIL_LENGTH = 4000;
const CONSUMER_INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

function getErrorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

function removePackSmokeTempRoot(tempRoot: string): void {
    try {
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true,
            maxRetries: process.platform === 'win32' ? 10 : 3,
            retryDelay: 100
        });
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (process.platform === 'win32' && RETRYABLE_WINDOWS_CLEANUP_CODES.has(errorCode)) {
            console.warn(`pack-smoke temp cleanup skipped after retryable Windows ${errorCode}: ${tempRoot}`);
            return;
        }
        throw error;
    }
}

function loadPackFixtureItems(repoRoot: string): string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = new Set<string>(pkgJson.files || []);
    items.delete('dist');
    items.delete('bin');
    items.add('package.json');
    items.add('scripts/package-legacy-entrypoint-compat.cjs');
    items.add('scripts/node-foundation');
    items.add('tsconfig.build.json');
    items.add('tsconfig.scripts.json');
    return Array.from(items).sort();
}

function copyPackFixture(repoRoot: string, fixtureRoot: string): void {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of loadPackFixtureItems(repoRoot)) {
        const src = path.join(repoRoot, relativePath);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(fixtureRoot, relativePath), { recursive: true });
    }
    // Symlink node_modules so tsc is available for the publish-runtime build
    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }
}

function quoteWindowsArgument(argument: string): string {
    const text = String(argument || '');
    if (!text || !/[ \t"]/u.test(text)) {
        return text;
    }

    let escaped = '"';
    let backslashCount = 0;
    for (const character of text) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }
        if (character === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }
        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }
        escaped += character;
    }
    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }
    escaped += '"';
    return escaped;
}

function spawnNpm(args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    if (process.platform === 'win32') {
        const commandLine = ['npm.cmd', ...args].map(quoteWindowsArgument).join(' ');
        return childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            cwd,
            encoding: 'utf8',
            timeout: 120_000,
            windowsHide: true
        });
    }

    return childProcess.spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });
}

function spawnGit(args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });
}

function formatSpawnFailure(label: string, result: childProcess.SpawnSyncReturns<string>): string {
    const lines = [`${label} failed:`];
    if (result.error) lines.push(`error=${result.error.message}`);
    if (result.status !== null) lines.push(`exit=${result.status}`);
    if (result.signal) lines.push(`signal=${result.signal}`);
    if (result.stdout) lines.push(`stdout:\n${tailOutput(result.stdout)}`);
    if (result.stderr) lines.push(`stderr:\n${tailOutput(result.stderr)}`);
    return lines.join('\n');
}

function tailOutput(output: string): string {
    if (output.length <= SPAWN_OUTPUT_TAIL_LENGTH) {
        return output;
    }
    return `[truncated to last ${SPAWN_OUTPUT_TAIL_LENGTH} chars]\n${output.slice(-SPAWN_OUTPUT_TAIL_LENGTH)}`;
}

function runGit(args: string[], cwd: string): void {
    const result = spawnGit(args, cwd);
    if (result.status !== 0) {
        throw new Error(formatSpawnFailure(`git ${args.join(' ')}`, result));
    }
}

function initializeCleanPackFixture(repoRoot: string): void {
    fs.writeFileSync(
        path.join(repoRoot, '.gitignore'),
        [
            'node_modules/',
            '.scripts-build/',
            '.scripts-build.lock/',
            '.node-build/',
            '.node-build.lock/',
            '*.tgz',
            ''
        ].join('\n'),
        'utf8'
    );

    const buildResult = spawnNpm(['run', 'build:publish-runtime'], repoRoot);
    if (buildResult.status !== 0) {
        throw new Error(formatSpawnFailure('npm run build:publish-runtime', buildResult));
    }

    runGit(['-c', 'init.defaultBranch=main', 'init'], repoRoot);
    runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    runGit(['config', 'user.name', 'Garda Test'], repoRoot);
    runGit(['add', '-A'], repoRoot);
    runGit(['commit', '--no-gpg-sign', '-m', 'pack fixture baseline'], repoRoot);
}

function assertNoConsumerInstallLifecycleScripts(packageJson: { scripts?: Record<string, string> }): void {
    const scripts = packageJson.scripts || {};
    for (const scriptName of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
        assert.equal(
            scripts[scriptName],
            undefined,
            `packed package must not run ${scriptName} during consumer install`
        );
    }
}

function npmPack(repoRoot: string): string {
    const legacyClaudeTemplatePath = path.join(repoRoot, 'template', 'CLAUDE.md');
    assert.ok(
        !fs.existsSync(legacyClaudeTemplatePath),
        'fixture source tree must not start with a stored template/CLAUDE.md'
    );

    const result = spawnNpm(['pack', '--pack-destination', repoRoot], repoRoot);

    if (result.status !== 0) {
        throw new Error(formatSpawnFailure('npm pack', result));
    }

    assert.ok(
        !fs.existsSync(legacyClaudeTemplatePath),
        'postpack must remove the generated legacy template/CLAUDE.md from the package source tree'
    );

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    return lines[lines.length - 1].trim();
}

function npmInstallTarball(tarballPath: string, installDir: string): void {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
        path.join(installDir, 'package.json'),
        JSON.stringify({ name: 'gao-smoke-test', version: '0.0.0', private: true }, null, 2),
        'utf8'
    );

    const result = spawnNpm([
        'install',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-fund',
        '--no-audit',
        '--no-progress',
        tarballPath
    ], installDir);

    if (result.status !== 0) {
        throw new Error(formatSpawnFailure('npm install', result));
    }
}

function runCli(cliScriptPath: string, args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(
        process.execPath,
        [cliScriptPath, ...args],
        {
            cwd,
            encoding: 'utf8',
            timeout: 30_000
        }
    );
}

test('npm pack -> install -> CLI invoke smoke test', () => {
    const repoRoot = getRepoRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const expectedVersion = packageJson.version;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pack-smoke-'));
    const fixtureRoot = path.join(tempRoot, 'pack-repo');
    const installRoot = path.join(tempRoot, 'install-root');

    try {
        assertNoConsumerInstallLifecycleScripts(packageJson);
        copyPackFixture(repoRoot, fixtureRoot);
        initializeCleanPackFixture(fixtureRoot);

        const tarballFilename = npmPack(fixtureRoot);
        const tarballPath = path.join(fixtureRoot, tarballFilename);

        assert.ok(fs.existsSync(tarballPath), `Tarball not found at ${tarballPath}`);

        npmInstallTarball(tarballPath, installRoot);

        const installedPackageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
        assert.ok(fs.existsSync(installedPackageRoot), 'Installed package root must exist');

        const cliScript = path.join(installedPackageRoot, 'bin', 'garda.js');
        assert.ok(fs.existsSync(cliScript), 'bin/garda.js must be present in installed package');
        assert.ok(fs.existsSync(path.join(installedPackageRoot, 'bin', 'garda.js')), 'legacy bin/garda.js must remain present in installed package');

        // 1. Compiled dist/ must be present (prepack build result)
        assert.ok(
            fs.existsSync(path.join(installedPackageRoot, 'dist', 'src', 'index.js')),
            'dist/src/index.js must exist in the installed package'
        );
        assert.ok(
            !fs.existsSync(path.join(installedPackageRoot, '.node-build')),
            'installed package must not include .node-build'
        );
        assert.ok(
            fs.existsSync(path.join(installedPackageRoot, 'template', 'entrypoints', 'canonical-rule-index.md')),
            'neutral canonical rule-index template must exist in the installed package'
        );
        const installedLegacyTemplatePath = path.join(installedPackageRoot, 'template', 'CLAUDE.md');
        assert.ok(
            fs.existsSync(installedLegacyTemplatePath),
            'packed package must include generated legacy template/CLAUDE.md for 1.0.0 updater compatibility'
        );
        assert.ok(
            fs.readFileSync(installedLegacyTemplatePath, 'utf8').includes('# CLAUDE.md'),
            'generated legacy template/CLAUDE.md must be provider-specific only inside the packed package'
        );

        // 2. --version prints the correct version
        const versionResult = runCli(cliScript, ['--version'], installRoot);
        assert.equal(versionResult.status, 0, `--version failed: ${versionResult.stderr}`);
        assert.match(versionResult.stdout.trim(), new RegExp(`^${expectedVersion.replace(/\./g, '\\.')}$`));

        // 3. --help prints usage information
        const helpResult = runCli(cliScript, ['--help'], installRoot);
        assert.equal(helpResult.status, 0, `--help failed: ${helpResult.stderr}`);
        assert.match(helpResult.stdout, /Usage:/);
        assert.match(helpResult.stdout, /setup/);

        // 4. status command works against a bare workspace (exercises compiled runtime)
        const workspaceRoot = path.join(installRoot, 'workspace');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        const statusResult = runCli(cliScript, ['status', '--target-root', workspaceRoot], workspaceRoot);
        assert.equal(statusResult.status, 0, `status failed: ${statusResult.stderr || statusResult.stdout}`);
        assert.match(statusResult.stdout, /GARDA_STATUS/);

        // 5. No TypeScript stripping warnings from node_modules
        const combinedOutput = [
            versionResult.stdout, versionResult.stderr,
            helpResult.stdout, helpResult.stderr,
            statusResult.stdout, statusResult.stderr
        ].join('\n');
        assert.doesNotMatch(
            combinedOutput,
            /Stripping types is currently unsupported for files under node_modules/i,
            'CLI must not produce TypeScript stripping warnings from node_modules'
        );
    } finally {
        removePackSmokeTempRoot(tempRoot);
    }
});
