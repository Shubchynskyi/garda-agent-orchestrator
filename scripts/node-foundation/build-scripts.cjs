const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    acquireBuildRootLock,
    getBuildRootLockPath,
    releaseBuildRootLock,
    resetBuildRoot,
    sleepSync
} = require('./build-root-lock.cjs');

const SCRIPT_RUNTIME_SUPPORT_FILES = Object.freeze(['build-root-lock.cjs']);

function appendTraceLine(tracePath, message) {
    if (!tracePath) {
        return;
    }

    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${message}\n`, 'utf8');
}

function runProcess(command, args, cwd) {
    const result = childProcess.spawnSync(command, args, {
        cwd,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} failed (exit ${result.status})`);
    }
}

function copyScriptRuntimeSupportFiles(repoRoot, buildRoot) {
    const compiledScriptsRoot = path.join(buildRoot, 'scripts', 'node-foundation');
    fs.mkdirSync(compiledScriptsRoot, { recursive: true });

    for (const fileName of SCRIPT_RUNTIME_SUPPORT_FILES) {
        const sourcePath = path.join(repoRoot, 'scripts', 'node-foundation', fileName);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Script runtime support file not found: ${sourcePath}`);
        }
        fs.copyFileSync(sourcePath, path.join(compiledScriptsRoot, fileName));
    }
}

function main() {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const buildRoot = path.join(repoRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);
    const tracePath = process.env.GARDA_BUILD_SCRIPTS_TRACE_FILE || '';
    const holdMs = Number(process.env.GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS || '0');
    const tscCliPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const entryArguments = process.argv.slice(2);
    const entryScript = entryArguments[0] || 'build.js';
    const entryArgs = entryArguments.length > 0 ? entryArguments.slice(1) : ['sync-repo-cli'];
    const compiledEntryPath = path.join(repoRoot, '.scripts-build', 'scripts', 'node-foundation', entryScript);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    acquireBuildRootLock(lockPath);
    appendTraceLine(tracePath, `acquired ${process.pid} ${Date.now()}`);
    try {
        if (holdMs > 0) {
            sleepSync(holdMs);
        }
        resetBuildRoot(buildRoot);
        runProcess(process.execPath, [tscCliPath, '-p', 'tsconfig.scripts.json', '--outDir', '.scripts-build'], repoRoot);
        copyScriptRuntimeSupportFiles(repoRoot, buildRoot);
        runProcess(process.execPath, [compiledEntryPath, ...entryArgs], repoRoot);
    } finally {
        appendTraceLine(tracePath, `released ${process.pid} ${Date.now()}`);
        releaseBuildRootLock(lockPath);
    }
}

main();
