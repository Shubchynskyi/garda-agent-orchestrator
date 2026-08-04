export * from './release-validation/types';
export * from './release-validation/version-parity';
export * from './release-validation/clean-worktree';
export * from './release-validation/embedded-bundle-parity';
export * from './release-validation/readiness';
export * from './release-validation/release-metadata';
export * from './release-validation/package-surface-types';
export * from './release-validation/package-surface-collect';
export * from './release-validation/package-surface-baseline';
export * from './release-validation/package-surface';
export * from './release-validation/package-surface-cli';
export * from './release-validation/cli';

import { runReleaseValidationCli } from './release-validation/cli';

if (require.main === module) {
    runReleaseValidationCli(process.argv[2], process.argv.slice(3));
}
