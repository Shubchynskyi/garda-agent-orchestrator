export {
    DEFAULT_PACKAGE_NAME,
    DEFAULT_UPDATE_TEMP_TTL_MS,
    acquireUpdateSource,
    cleanupOldUpdateTempRoots,
    getUpdateTempRoot,
    resolveNpmUpdateSourceSpec
} from './check-update/check-update-source';
export { runCheckUpdate } from './check-update/check-update-runner';
export type {
    AcquiredUpdateSource,
    AcquireUpdateSourceOptions,
    CheckUpdateOptions,
    CheckUpdateResult,
    CheckUpdateRunnerOptions,
    CheckUpdateTestHooks,
    NpmInstallResult,
    NpmViewResult,
    ResolvedNpmUpdateSource,
    ResolveInstalledPackageRootOptions,
    ResolveNpmUpdateSourceSpecOptions
} from './check-update/check-update-types';
