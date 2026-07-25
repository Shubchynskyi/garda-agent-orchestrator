export * from './dependency-boundaries';

import { runDependencyBoundaryCheck } from './dependency-boundaries';

if (require.main === module) {
    process.exitCode = runDependencyBoundaryCheck();
}
