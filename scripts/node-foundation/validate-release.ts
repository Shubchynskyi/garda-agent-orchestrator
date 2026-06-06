export * from './release-validation/types';
export * from './release-validation/version-parity';
export * from './release-validation/clean-worktree';
export * from './release-validation/embedded-bundle-parity';
export * from './release-validation/readiness';
export * from './release-validation/cli';

import { runReleaseValidationCli } from './release-validation/cli';

if (require.main === module) {
    runReleaseValidationCli(process.argv[2]);
}
