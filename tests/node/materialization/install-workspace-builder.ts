/**
 * Transparent workspace builders for install test suites.
 *
 * Each helper creates exactly the directory structure it describes so callers
 * can see precisely which paths exist before assertions run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/common';

// ── Repo root discovery ───────────────────────────────────────────────────

export function findRepoRoot(): string {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

// ── Copy helper ───────────────────────────────────────────────────────────

export function copyDirRecursive(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

// ── Test workspace: tmpDir with mock bundle, VERSION, template, .git ──────

export interface InstallWorkspace {
    projectRoot: string;
    bundleRoot: string;
}

export function setupTestWorkspace(bundleSourceRoot: string): InstallWorkspace {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-'));

    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    fs.copyFileSync(path.join(bundleSourceRoot, 'VERSION'), path.join(bundle, 'VERSION'));

    const templateSrc = path.join(bundleSourceRoot, 'template');
    const templateDst = path.join(bundle, 'template');
    copyDirRecursive(templateSrc, templateDst);

    const runtimeDir = path.join(bundle, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    fs.mkdirSync(path.join(bundle, 'live'), { recursive: true });

    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

// ── Init answers writer ───────────────────────────────────────────────────

export function writeInitAnswers(bundleRoot: string, answers: Record<string, unknown>): string {
    const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));
    return answersPath;
}

// ── Lifecycle lock seeder ─────────────────────────────────────────────────

export function seedLifecycleOperationLock(
    projectRoot: string,
    pid: number,
    hostname: string = os.hostname()
): string {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-05T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2));
    return lockPath;
}

// ── Captured init runner type ─────────────────────────────────────────────

export type CapturedInitRunnerOptions = {
    claudeOrchestratorFullAccess?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
};
