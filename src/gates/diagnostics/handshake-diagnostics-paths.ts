import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../../core/constants';
import {
    joinOrchestratorPath,
    resolvePathInsideRepo
} from '../shared/helpers';

export function resolveCliPath(isSourceCheckout: boolean): string {
    if (isSourceCheckout) {
        return getSourceCliCommand();
    }
    return getBundleCliCommand(resolveBundleName());
}

export function resolveHandshakeArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('HandshakeArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-handshake.json`));
}
