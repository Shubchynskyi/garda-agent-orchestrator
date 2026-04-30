import { normalizePath } from './helpers';

const GENERATED_ORCHESTRATOR_LOCK_PATHS = Object.freeze([
    '.scripts-build.lock',
    '.node-build.lock',
    'dist.lock',
    'bin/.garda-cli-sync.lock'
]);

export function isGeneratedOrchestratorLockPath(relativePath: string | null | undefined): boolean {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) {
        return false;
    }

    return GENERATED_ORCHESTRATOR_LOCK_PATHS.some((lockPath) => (
        normalized === lockPath || normalized.startsWith(`${lockPath}/`)
    ));
}
