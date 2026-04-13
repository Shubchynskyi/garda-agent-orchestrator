import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function loadPackFixtureItems(repoRoot: string): string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = new Set<string>(pkgJson.files || []);
    items.delete('dist');
    items.delete('bin');
    items.add('package.json');
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

function getTypescriptCliPath(repoRoot: string): string {
    return path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

function syncGeneratedCliEntrypoint(repoRoot: string): void {
    const compiledCliTargets = [
        {
            compiledPath: path.join(repoRoot, 'dist', 'src', 'bin', 'garda.js'),
            repoPath: path.join(repoRoot, 'bin', 'garda.js')
        },
        {
            compiledPath: path.join(repoRoot, 'dist', 'src', 'bin', 'garda.js'),
            repoPath: path.join(repoRoot, 'bin', 'garda.js')
        }
    ];
    for (const target of compiledCliTargets) {
        if (!fs.existsSync(target.compiledPath)) {
            throw new Error(`compiled CLI launcher not found: ${target.compiledPath}`);
        }
    }
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    for (const target of compiledCliTargets) {
        fs.copyFileSync(target.compiledPath, target.repoPath);
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

function buildPublishRuntimeInRepo(repoRoot: string): void {
    const result = childProcess.spawnSync(process.execPath, [getTypescriptCliPath(repoRoot), '-p', 'tsconfig.build.json'], {
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

function npmPack(repoRoot: string): string {
    // Build dist/ explicitly in an isolated fixture repo so this smoke test
    // does not race with other packaging tests that also materialize dist/.
    buildPublishRuntimeInRepo(repoRoot);

    const result = spawnNpm(['pack', '--ignore-scripts', '--pack-destination', repoRoot], repoRoot);

    if (result.status !== 0) {
        throw new Error(`npm pack failed:\n${result.stderr || result.stdout}`);
    }

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const tarballFilename = lines[lines.length - 1].trim();
    return tarballFilename;
}

function npmInstallTarball(tarballPath: string, installDir: string): void {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
        path.join(installDir, 'package.json'),
        JSON.stringify({ name: 'gao-smoke-test', version: '0.0.0', private: true }, null, 2),
        'utf8'
    );

    const result = spawnNpm(['install', '--no-fund', '--no-audit', '--no-progress', tarballPath], installDir);

    if (result.status !== 0) {
        throw new Error(`npm install failed:\n${result.stderr || result.stdout}`);
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
        copyPackFixture(repoRoot, fixtureRoot);

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
        assert.match(statusResult.stdout, /GARDA_STATUS|GARDA_STATUS/);

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
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
