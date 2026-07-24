import * as path from 'node:path';

import {
    detectCodeChanged as detectCoreCodeChanged
} from '../../core/preflight-code-change';
import {
    classifyScopeCategory,
    getClassificationConfig
} from './classify-change';

type ClassificationConfigRecord = ReturnType<typeof getClassificationConfig>;

const classificationConfigCache = new Map<string, ClassificationConfigRecord>();

function getCachedClassificationConfig(repoRoot: string): ClassificationConfigRecord {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const cached = classificationConfigCache.get(resolvedRepoRoot);
    if (cached) {
        return cached;
    }
    const loaded = getClassificationConfig(resolvedRepoRoot);
    classificationConfigCache.set(resolvedRepoRoot, loaded);
    return loaded;
}

export { preflightRequiresAnyReview } from '../../core/preflight-code-change';

/**
 * Compatibility facade that supplies legacy workspace-aware classification to
 * the dependency-safe core detector.
 */
export function detectCodeChanged(preflight: Record<string, unknown> | null, repoRoot = '.'): boolean {
    return detectCoreCodeChanged(preflight, repoRoot, (changedFiles, resolvedRepoRoot) => {
        const classificationConfig = getCachedClassificationConfig(resolvedRepoRoot);
        return classifyScopeCategory(
            changedFiles,
            classificationConfig.code_like_regexes,
            classificationConfig.runtime_roots,
            {
                ordinaryDocPaths: classificationConfig.ordinary_doc_paths,
                protectedControlPlaneRoots: classificationConfig.protected_control_plane_roots,
                sqlOrMigrationRegexes: classificationConfig.sql_or_migration_regexes,
                dbTriggerRegexes: classificationConfig.db_trigger_regexes,
                securityTriggerRegexes: classificationConfig.security_trigger_regexes,
                apiTriggerRegexes: classificationConfig.api_trigger_regexes,
                dependencyTriggerRegexes: classificationConfig.dependency_trigger_regexes
            }
        ).category;
    });
}
