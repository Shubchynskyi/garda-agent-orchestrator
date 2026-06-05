import { buildReviewExecutionPolicySummaryLine } from '../../core/review-execution-policy';
import { matchAnyRegex } from '../../gate-runtime/text-utils';
import {
    buildGeneratedRuntimeArtifactHygieneWarnings,
    splitGeneratedRuntimeControlPlaneArtifacts
} from '../shared/generated-runtime-artifacts';
import { testPathPrefix } from '../shared/helpers';
import {
    type ClassifyChangeOptions,
    matchesConfiguredRoot
} from './classify-change-config';
import {
    collectDatabaseProjectEvidence,
    isConfiguredWeakDatabaseSignal,
    isStrongDatabaseChangedScope
} from './classify-change-db-evidence';
import {
    getSafeOrdinaryDocPathMatches,
    isOrdinaryOrchestratorCacheMaintenancePath,
    isProtectedControlPlaneDocumentationSurfacePath
} from './classify-change-doc-safety';
import {
    buildRefactorHeuristicReasons,
    isPerformanceHeuristicTriggered
} from './classify-change-heuristics';
import { hasRefactorIntent } from './classify-change-intent';
import { detectPathTriggers } from './classify-change-path-detection';
import { buildRequiredReviews } from './classify-change-required-reviews';
import { classifyScopeCategory } from './classify-change-scope-category';

export type {
    ClassificationConfig,
    ClassifyChangeOptions,
    ResolvedClassificationConfig
} from './classify-change-config';
export {
    getClassificationConfig,
    getDefaultClassificationConfig,
    getReviewCapabilities,
    matchesConfiguredRoot
} from './classify-change-config';
export {
    isConfigLikePath,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath
} from './classify-change-doc-safety';
export type { ScopeCategory } from './classify-change-scope-category';
export { classifyScopeCategory } from './classify-change-scope-category';

/**
 * Pure-logic classification of changed files.
 * Produces the canonical classify-change output shape.
 */
export function classifyChange(options: ClassifyChangeOptions) {
    const normalizedInputFiles = options.normalizedFiles || [];
    const generatedRuntimeSplit = splitGeneratedRuntimeControlPlaneArtifacts(normalizedInputFiles);
    const normalizedFiles = generatedRuntimeSplit.reviewableFiles;
    const ignoredGeneratedRuntimeFiles = generatedRuntimeSplit.ignoredGeneratedRuntimeFiles;
    const taskIntent = options.taskIntent || '';
    const fastPathMaxFiles = options.fastPathMaxFiles || 2;
    const fastPathMaxChangedLines = options.fastPathMaxChangedLines || 40;
    const performanceHeuristicMinLines = options.performanceHeuristicMinLines || 120;
    const changedLinesTotal = options.changedLinesTotal || 0;
    const additionsTotal = options.additionsTotal || 0;
    const deletionsTotal = options.deletionsTotal || 0;
    const renameCount = options.renameCount || 0;
    const detectionSource = options.detectionSource || 'explicit_changed_files';
    const classificationConfig = options.classificationConfig;
    const reviewCapabilities = options.reviewCapabilities || {};
    const reviewExecutionPolicyMode = options.reviewExecutionPolicyMode;

    const runtimeRoots = classificationConfig.runtime_roots;
    const codeLike = classificationConfig.code_like_regexes;

    const testMatch = (p: string, regexes: string[]) => matchAnyRegex(p, regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });

    const pathTriggers = detectPathTriggers({
        normalizedFiles,
        repoRoot: options.repoRoot,
        taskIntent,
        classificationConfig,
        callbacks: {
            testMatch,
            testPathPrefix,
            matchesConfiguredRoot,
            isProtectedControlPlaneDocumentationSurfacePath,
            isStrongDatabaseChangedScope,
            isConfiguredWeakDatabaseSignal,
            collectDatabaseProjectEvidence,
            getSafeOrdinaryDocPathMatches,
            isOrdinaryOrchestratorCacheMaintenancePath
        }
    });

    const refactorIntentTriggered = hasRefactorIntent(taskIntent);
    const refactorHeuristicReasons = buildRefactorHeuristicReasons({
        runtimeChanged: pathTriggers.runtimeChanged,
        normalizedFilesCount: normalizedFiles.length,
        renameCount,
        additionsTotal,
        deletionsTotal,
        runtimeCodeLikeCount: pathTriggers.runtimeCodeLikeCount,
        dbTriggered: pathTriggers.dbTriggered,
        securityTriggered: pathTriggers.securityTriggered
    });
    const refactorHeuristicTriggered = refactorHeuristicReasons.length > 0;
    const refactorTriggered = refactorIntentTriggered || refactorHeuristicTriggered;

    const performanceHeuristicTriggered = isPerformanceHeuristicTriggered({
        performancePathTriggered: pathTriggers.performancePathTriggered,
        apiTriggered: pathTriggers.apiTriggered,
        dbTriggered: pathTriggers.dbTriggered,
        runtimeCodeChanged: pathTriggers.runtimeCodeChanged,
        onlySqlOrMigration: pathTriggers.onlySqlOrMigration,
        changedLinesTotal,
        performanceHeuristicMinLines
    });
    const performanceTriggered = pathTriggers.performancePathTriggered || performanceHeuristicTriggered;

    const fastPathEligible = (
        pathTriggers.runtimeChanged
        && pathTriggers.allUnderFastRoots
        && pathTriggers.allFastAllowedTypes
        && !pathTriggers.hasFastSensitiveMatch
        && normalizedFiles.length <= fastPathMaxFiles
        && changedLinesTotal <= fastPathMaxChangedLines
    );

    let mode = 'FULL_PATH';
    if (fastPathEligible && !pathTriggers.dbTriggered && !pathTriggers.securityTriggered && !refactorTriggered
        && !pathTriggers.apiTriggered && !pathTriggers.dependencyTriggered && !pathTriggers.infraTriggered && !performanceTriggered) {
        mode = 'FAST_PATH';
    }

    const requiredReviews = buildRequiredReviews({
        runtimeCodeChanged: pathTriggers.runtimeCodeChanged,
        mode,
        dbTriggered: pathTriggers.dbTriggered,
        securityTriggered: pathTriggers.securityTriggered,
        refactorTriggered,
        apiTriggered: pathTriggers.apiTriggered,
        testTriggered: pathTriggers.testTriggered,
        performanceTriggered,
        infraTriggered: pathTriggers.infraTriggered,
        dependencyTriggered: pathTriggers.dependencyTriggered,
        reviewCapabilities
    });
    const zeroDiffDetected = normalizedFiles.length === 0 && changedLinesTotal === 0;

    const scopeClassification = classifyScopeCategory(normalizedFiles, codeLike, runtimeRoots, {
        ordinaryDocPaths: classificationConfig.ordinary_doc_paths,
        protectedControlPlaneRoots: classificationConfig.protected_control_plane_roots,
        testTriggerRegexes: classificationConfig.test_trigger_regexes,
        sqlOrMigrationRegexes: classificationConfig.sql_or_migration_regexes,
        dbTriggerRegexes: classificationConfig.db_trigger_regexes,
        securityTriggerRegexes: classificationConfig.security_trigger_regexes,
        apiTriggerRegexes: classificationConfig.api_trigger_regexes,
        dependencyTriggerRegexes: classificationConfig.dependency_trigger_regexes
    });

    return {
        detection_source: detectionSource,
        mode,
        scope_category: scopeClassification.category,
        scope_category_reasons: scopeClassification.reasons,
        metrics: {
            classification_config_source: classificationConfig.source,
            classification_config_path: classificationConfig.config_path,
            changed_files_count: normalizedFiles.length,
            ignored_generated_runtime_files_count: ignoredGeneratedRuntimeFiles.length,
            changed_lines_total: changedLinesTotal,
            additions_total: additionsTotal,
            deletions_total: deletionsTotal,
            rename_count: renameCount,
            code_like_changed_count: pathTriggers.codeLikeCount,
            runtime_code_like_changed_count: pathTriggers.runtimeCodeLikeCount,
            review_capabilities: reviewCapabilities,
            fast_path_max_files: fastPathMaxFiles,
            fast_path_max_changed_lines: fastPathMaxChangedLines,
            performance_heuristic_min_lines: performanceHeuristicMinLines
        },
        triggers: {
            runtime_changed: pathTriggers.runtimeChanged,
            runtime_code_changed: pathTriggers.runtimeCodeChanged,
            protected_control_plane_changed: pathTriggers.protectedControlPlaneChanged,
            protected_control_plane_docs_only: pathTriggers.protectedControlPlaneDocsOnly,
            changed_protected_files: pathTriggers.protectedControlPlaneFiles,
            db: pathTriggers.dbTriggered,
            db_strong_changed_files: pathTriggers.dbStrongChangedFiles,
            db_weak_signal_files: pathTriggers.dbWeakSignalFiles,
            db_project_evidence: pathTriggers.dbProjectEvidence,
            security: pathTriggers.securityTriggered,
            api: pathTriggers.apiTriggered,
            test: pathTriggers.testTriggered,
            performance: performanceTriggered,
            infra: pathTriggers.infraTriggered,
            dependency: pathTriggers.dependencyTriggered,
            refactor: refactorTriggered,
            refactor_intent: refactorIntentTriggered,
            refactor_heuristic: refactorHeuristicTriggered,
            refactor_heuristic_reasons: refactorHeuristicReasons,
            ordinary_doc_path_matches: pathTriggers.ordinaryDocPathMatches,
            ordinary_doc_path_matched_files: pathTriggers.ordinaryDocPathMatchedFiles,
            ordinary_doc_path_patterns: classificationConfig.ordinary_doc_paths,
            test_ordinary_doc_suppressed_files: pathTriggers.testOrdinaryDocSuppressedFiles,
            performance_path_changed_files: pathTriggers.performancePathTriggeredFiles,
            performance_cache_candidate_files: pathTriggers.ordinaryCacheMaintenanceFiles,
            performance_cache_intent: pathTriggers.performanceCacheIntent,
            performance_cache_suppressed_files: pathTriggers.performanceCacheSuppressedFiles,
            performance_heuristic: performanceHeuristicTriggered,
            fast_path_eligible: fastPathEligible,
            fast_path_sensitive_match: pathTriggers.hasFastSensitiveMatch,
            ignored_generated_runtime_files: ignoredGeneratedRuntimeFiles
        },
        required_reviews: requiredReviews,
        review_execution_policy: reviewExecutionPolicyMode
            ? {
                mode: reviewExecutionPolicyMode,
                visible_summary_line: buildReviewExecutionPolicySummaryLine(reviewExecutionPolicyMode)
            }
            : undefined,
        zero_diff_guard: {
            zero_diff_detected: zeroDiffDetected,
            status: zeroDiffDetected ? 'BASELINE_ONLY' : 'DIFF_PRESENT',
            completion_requires_audited_no_op: zeroDiffDetected,
            no_op_artifact_suffix: zeroDiffDetected ? '-no-op.json' : null,
            rationale: zeroDiffDetected
                ? 'Preflight on a clean workspace is baseline-only. Task completion requires a produced diff or an audited no-op artifact.'
                : 'Workspace diff detected.'
        },
        workspace_hygiene_warnings: buildGeneratedRuntimeArtifactHygieneWarnings(ignoredGeneratedRuntimeFiles),
        changed_files: normalizedFiles
    };
}
