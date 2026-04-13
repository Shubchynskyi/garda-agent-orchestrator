import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchAnyRegex } from '../gate-runtime/text-utils';
import {
    normalizePath,
    joinOrchestratorPath,
    getProtectedControlPlaneRoots,
    normalizeProtectedControlPlaneRoots,
    normalizeRootPrefixes,
    orchestratorRelativePath,
    testPathPrefix,
    toPosix,
    toStringArray
} from './helpers';
import { resolveGateExecutionPath } from './isolation-sandbox';

interface TriggerConfig {
    db: string[];
    security: string[];
    api: string[];
    dependency: string[];
    infra: string[];
    test: string[];
    performance: string[];
}

interface ClassificationConfig {
    metrics_path: string;
    runtime_roots: string[];
    fast_path_roots: string[];
    fast_path_allowed_regexes: string[];
    fast_path_sensitive_regexes: string[];
    sql_or_migration_regexes: string[];
    triggers: TriggerConfig;
    code_like_regexes: string[];
    protected_control_plane_roots: string[];
}

interface ResolvedClassificationConfig {
    source: string;
    config_path: string;
    metrics_path: string;
    runtime_roots: string[];
    fast_path_roots: string[];
    fast_path_allowed_regexes: string[];
    fast_path_sensitive_regexes: string[];
    sql_or_migration_regexes: string[];
    db_trigger_regexes: string[];
    security_trigger_regexes: string[];
    api_trigger_regexes: string[];
    dependency_trigger_regexes: string[];
    infra_trigger_regexes: string[];
    test_trigger_regexes: string[];
    performance_trigger_regexes: string[];
    code_like_regexes: string[];
    protected_control_plane_roots: string[];
}

interface ReviewCapabilities {
    code: boolean;
    db: boolean;
    security: boolean;
    refactor: boolean;
    api: boolean;
    test: boolean;
    performance: boolean;
    infra: boolean;
    dependency: boolean;
    [key: string]: boolean;
}

interface MatchConfiguredRootOptions {
    allowNestedRoot?: boolean;
    semanticPackageMatch?: boolean;
}

export interface ClassifyChangeOptions {
    normalizedFiles?: string[];
    taskIntent?: string;
    fastPathMaxFiles?: number;
    fastPathMaxChangedLines?: number;
    performanceHeuristicMinLines?: number;
    changedLinesTotal?: number;
    additionsTotal?: number;
    deletionsTotal?: number;
    renameCount?: number;
    detectionSource?: string;
    classificationConfig: ResolvedClassificationConfig;
    reviewCapabilities?: Partial<ReviewCapabilities>;
}

/**
 * Default classification config for the Node gate runtime.
 */
export function getDefaultClassificationConfig(repoRoot: string): ClassificationConfig {
    return {
        metrics_path: orchestratorRelativePath(repoRoot, 'runtime/metrics.jsonl'),
        runtime_roots: ['src/', 'app/', 'apps/', 'backend/', 'frontend/', 'web/', 'api/', 'services/', 'packages/'],
        fast_path_roots: ['frontend/', 'web/', 'ui/', 'mobile/', 'apps/'],
        fast_path_allowed_regexes: [
            '^.+\\.(ts|tsx|js|jsx|vue|svelte|css|scss|sass|less|html)$',
            '^.+\\.(svg|png|jpg|jpeg|webp|ico)$'
        ],
        fast_path_sensitive_regexes: [
            '(^|/)(auth|security|payment|checkout|webhook|token|jwt|guard|middleware|service|repository|query|migration|sql|datasource)(/|\\.|$)'
        ],
        sql_or_migration_regexes: ['\\.sql$', '(^|/)(db|database|migrations?|schema)(/|$)'],
        triggers: {
            db: [
                '(^|/)(db|database|migrations?|schema)(/|$)',
                '\\.sql$',
                '(Repository|Dao|Specification|Query|Migration)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$',
                '(typeorm|prisma|flyway|liquibase|alembic|knex|sequelize)'
            ],
            security: [
                '(^|/)(auth|security|oauth|jwt|token|rbac|acl|keycloak|okta|saml|openid|mfa|crypt|encryption|certificate|secret|vault|webhook|payment|checkout|billing)(/|\\.|$)'
            ],
            api: [
                '(^|/)(controllers?|routes?|handlers?|endpoints?|graphql)(/|\\.|$)',
                '(Request|Response|Dto|DTO|Contract|Schema)[^/]*\\.(java|kt|ts|tsx|js|jsx|py|go|cs|rb|php)$',
                '(^|/)(openapi|swagger)\\.(ya?ml|json)$'
            ],
            dependency: [
                '(^|/)pom\\.xml$',
                '(^|/)build\\.gradle(\\.kts)?$',
                '(^|/)settings\\.gradle(\\.kts)?$',
                '(^|/)package\\.json$',
                '(^|/)package-lock\\.json$',
                '(^|/)pnpm-lock\\.yaml$',
                '(^|/)yarn\\.lock$',
                '(^|/)requirements(\\.txt|-dev\\.txt)?$',
                '(^|/)poetry\\.lock$',
                '(^|/)pyproject\\.toml$',
                '(^|/)go\\.mod$',
                '(^|/)go\\.sum$',
                '(^|/)Cargo\\.toml$',
                '(^|/)Cargo\\.lock$',
                '(^|/)composer\\.json$',
                '(^|/)Gemfile(\\.lock)?$'
            ],
            infra: [
                '(^|/)Dockerfile(\\..+)?$',
                '(^|/)docker-compose(\\.[^/]+)?\\.ya?ml$',
                '(^|/)(terraform|infra|infrastructure|helm|k8s|kubernetes)(/|$)',
                '(^|/)\\.github/workflows/'
            ],
            test: [
                '/src/test/',
                '(^|/)(__tests__|tests?)/',
                '\\.(spec|test)\\.(ts|tsx|js|jsx|java|kt|go|py|rb|php)$'
            ],
            performance: [
                '(Cache|Redis|Elasticsearch|Search|Query|Benchmark|Profil(e|ing))[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$',
                '(^|/)(performance|perf|benchmark)/'
            ]
        },
        code_like_regexes: ['\\.(java|kt|kts|groovy|ts|tsx|js|jsx|cjs|mjs|cs|go|py|rb|php|rs)$'],
        protected_control_plane_roots: getProtectedControlPlaneRoots(repoRoot)
    };
}

/**
 * Load classification config from paths.json with defaults.
 */
export function getClassificationConfig(repoRoot: string): ResolvedClassificationConfig {
    const defaults = getDefaultClassificationConfig(repoRoot);
    const configPath = resolveGateExecutionPath(repoRoot, 'live/config/paths.json');
    let source = 'defaults';

    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
            for (const key of [
                'metrics_path', 'runtime_roots', 'fast_path_roots',
                'fast_path_allowed_regexes', 'fast_path_sensitive_regexes',
                'sql_or_migration_regexes', 'code_like_regexes', 'protected_control_plane_roots'
            ] as const) {
                if (key in raw) (defaults as unknown as Record<string, unknown>)[key] = raw[key];
            }
            if (raw.triggers && typeof raw.triggers === 'object') {
                const rawTriggers = raw.triggers as Record<string, unknown>;
                for (const triggerKey of ['db', 'security', 'api', 'dependency', 'infra', 'test', 'performance'] as const) {
                    if (triggerKey in rawTriggers) {
                        defaults.triggers[triggerKey] = rawTriggers[triggerKey] as string[];
                    }
                }
            }
            source = 'paths_json';
        } catch {
            source = 'defaults_with_config_parse_error';
        }
    }

    return {
        source,
        config_path: toPosix(path.resolve(configPath)),
        metrics_path: String(defaults.metrics_path),
        runtime_roots: normalizeRootPrefixes(toStringArray(defaults.runtime_roots)),
        fast_path_roots: normalizeRootPrefixes(toStringArray(defaults.fast_path_roots)),
        fast_path_allowed_regexes: toStringArray(defaults.fast_path_allowed_regexes),
        fast_path_sensitive_regexes: toStringArray(defaults.fast_path_sensitive_regexes),
        sql_or_migration_regexes: toStringArray(defaults.sql_or_migration_regexes),
        db_trigger_regexes: toStringArray(defaults.triggers.db),
        security_trigger_regexes: toStringArray(defaults.triggers.security),
        api_trigger_regexes: toStringArray(defaults.triggers.api),
        dependency_trigger_regexes: toStringArray(defaults.triggers.dependency),
        infra_trigger_regexes: toStringArray(defaults.triggers.infra),
        test_trigger_regexes: toStringArray(defaults.triggers.test),
        performance_trigger_regexes: toStringArray(defaults.triggers.performance),
        code_like_regexes: toStringArray(defaults.code_like_regexes),
        protected_control_plane_roots: normalizeProtectedControlPlaneRoots(toStringArray(defaults.protected_control_plane_roots))
    };
}

/**
 * Load review capabilities from config file.
 */
export function getReviewCapabilities(repoRoot: string): ReviewCapabilities {
    const capabilities: ReviewCapabilities = {
        code: true, db: true, security: true, refactor: true,
        api: false, test: false, performance: false, infra: false, dependency: false
    };
    const configPath = resolveGateExecutionPath(repoRoot, 'live/config/review-capabilities.json');
    if (!fs.existsSync(configPath)) return capabilities;
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        for (const key of Object.keys(capabilities)) {
            if (key in raw) capabilities[key] = !!raw[key];
        }
    } catch { /* use defaults */ }
    return capabilities;
}

const GROUPED_PACKAGE_ROOTS = Object.freeze(['apps', 'packages', 'services', 'workspaces', 'projects']);

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRootTokens(roots: string[]): string[] {
    return normalizeRootPrefixes(toStringArray(roots))
        .map((root: string) => root.replace(/\/+$/, '').toLowerCase())
        .filter(Boolean);
}

function matchesSemanticRoot(segment: string, rootTokens: string[]): boolean {
    const normalizedSegment = String(segment || '').trim().toLowerCase();
    if (!normalizedSegment) {
        return false;
    }

    return rootTokens.some((token: string) => {
        if (!token || token === 'src') {
            return false;
        }
        const pattern = new RegExp(`(^|[-_.])${escapeRegex(token)}($|[-_.])`, 'i');
        return pattern.test(normalizedSegment);
    });
}

function matchesConfiguredRoot(pathValue: string, roots: string[], options: MatchConfiguredRootOptions = {}): boolean {
    const normalizedPath = normalizePath(pathValue).toLowerCase();
    if (!normalizedPath) {
        return false;
    }

    if (testPathPrefix(normalizedPath, roots)) {
        return true;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) {
        return false;
    }

    const rootTokens = getRootTokens(roots);
    if (options.allowNestedRoot && rootTokens.includes(segments[1])) {
        return true;
    }

    if (!options.semanticPackageMatch) {
        return false;
    }

    const semanticCandidates = [segments[0]];
    if (GROUPED_PACKAGE_ROOTS.includes(segments[0]) && segments[1]) {
        semanticCandidates.push(segments[1]);
    }

    return semanticCandidates.some((candidate) => matchesSemanticRoot(candidate, rootTokens));
}

// ---------------------------------------------------------------------------
// Scope category classification
// ---------------------------------------------------------------------------

const DOC_LIKE_REGEXES = [
    '\\.(md|mdx|txt|rst|adoc|asciidoc|textile)$',
    '(^|/)docs?/',
    '(^|/)README',
    '(^|/)CHANGELOG',
    '(^|/)LICENSE',
    '(^|/)CONTRIBUTING',
    '(^|/)SECURITY\\.md$',
    '(^|/)NOTICE$',
    '(^|/)TRADEMARKS',
    '(^|/)CODEOWNERS$'
];

const CONFIG_LIKE_REGEXES = [
    '\\.(json|ya?ml|toml|ini|cfg|conf|env|properties|xml)$',
    '(^|/)\\.editorconfig$',
    '(^|/)tsconfig',
    '(^|/)jest\\.config',
    '(^|/)vitest\\.config',
    '(^|/)eslint',
    '(^|/)prettier',
    '(^|/)\\.github/workflows/',
    '(^|/)Dockerfile',
    '(^|/)docker-compose'
];

const AUDIT_ONLY_REGEXES = [
    '(^|/)TASK\\.md$',
    '(^|/)garda-agent-orchestrator/runtime/',
    '(^|/)\\.agents/',
    '(^|/)garda-agent-orchestrator/live/docs/agent-rules/',
    '(^|/)garda-agent-orchestrator/live/config/',
    '(^|/)garda-agent-orchestrator/live/docs/changes/'
];

// Pre-compiled regex arrays to avoid recompilation per file
const DOC_LIKE_COMPILED = DOC_LIKE_REGEXES.map((p) => new RegExp(p, 'i'));
const CONFIG_LIKE_COMPILED = CONFIG_LIKE_REGEXES.map((p) => new RegExp(p, 'i'));
const AUDIT_ONLY_COMPILED = AUDIT_ONLY_REGEXES.map((p) => new RegExp(p, 'i'));

function testPrecompiled(value: string, patterns: RegExp[]): boolean {
    return patterns.some((re) => re.test(value));
}

export type ScopeCategory = 'code' | 'docs-only' | 'config-only' | 'audit-only' | 'mixed' | 'empty';

/**
 * Classify the scope category from changed files.
 *
 * Categories:
 * - `code`: at least one code-like file under runtime roots
 * - `docs-only`: all files match documentation patterns
 * - `config-only`: all files match config/infra patterns (no code)
 * - `audit-only`: all files are orchestrator control-plane artifacts
 * - `mixed`: mix of code and non-code files
 * - `empty`: no changed files
 */
export function classifyScopeCategory(
    normalizedFiles: string[],
    codeLikeRegexes: string[],
    runtimeRoots: string[]
): { category: ScopeCategory; reasons: string[] } {
    if (normalizedFiles.length === 0) {
        return { category: 'empty', reasons: ['no_changed_files'] };
    }

    const testMatch = (p: string, regexes: string[]) => matchAnyRegex(p, regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });

    let codeCount = 0;
    let docCount = 0;
    let configCount = 0;
    let auditCount = 0;

    for (const file of normalizedFiles) {
        const isCode = testMatch(file, codeLikeRegexes)
            && matchesConfiguredRoot(file, runtimeRoots, { allowNestedRoot: true });
        const isDoc = testPrecompiled(file, DOC_LIKE_COMPILED);
        const isConfig = testPrecompiled(file, CONFIG_LIKE_COMPILED);
        const isAudit = testPrecompiled(file, AUDIT_ONLY_COMPILED);

        if (isCode) codeCount++;
        else if (isAudit) auditCount++;
        else if (isDoc) docCount++;
        else if (isConfig) configCount++;
        else codeCount++; // unknown files default to code for safety
    }

    const total = normalizedFiles.length;
    const reasons: string[] = [];

    if (codeCount > 0) {
        if (docCount > 0 || configCount > 0 || auditCount > 0) {
            reasons.push(`code=${codeCount}`, `docs=${docCount}`, `config=${configCount}`, `audit=${auditCount}`);
            return { category: 'mixed', reasons };
        }
        reasons.push(`code_files=${codeCount}`);
        return { category: 'code', reasons };
    }

    if (auditCount === total) {
        reasons.push(`audit_only_files=${auditCount}`);
        return { category: 'audit-only', reasons };
    }

    if (docCount === total) {
        reasons.push(`doc_only_files=${docCount}`);
        return { category: 'docs-only', reasons };
    }

    if (configCount === total) {
        reasons.push(`config_only_files=${configCount}`);
        return { category: 'config-only', reasons };
    }

    // Mix of non-code categories (e.g., docs + config)
    if (docCount > 0) reasons.push(`docs=${docCount}`);
    if (configCount > 0) reasons.push(`config=${configCount}`);
    if (auditCount > 0) reasons.push(`audit=${auditCount}`);
    return { category: 'docs-only', reasons: [...reasons, 'all_non_code'] };
}

/**
 * Pure-logic classification of changed files.
 * Produces the canonical classify-change output shape.
 */
export function classifyChange(options: ClassifyChangeOptions) {
    const normalizedFiles = options.normalizedFiles || [];
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

    const runtimeRoots = classificationConfig.runtime_roots;
    const fastPathRoots = classificationConfig.fast_path_roots;
    const fastPathAllowed = classificationConfig.fast_path_allowed_regexes;
    const fastPathSensitive = classificationConfig.fast_path_sensitive_regexes;
    const sqlOrMigration = classificationConfig.sql_or_migration_regexes;
    const codeLike = classificationConfig.code_like_regexes;

    const testMatch = (p: string, regexes: string[]) => matchAnyRegex(p, regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });

    const runtimeChanged = normalizedFiles.some((p: string) => matchesConfiguredRoot(p, runtimeRoots, {
        allowNestedRoot: true
    }));
    const runtimeCodeChanged = normalizedFiles.some((p: string) => matchesConfiguredRoot(p, runtimeRoots, {
        allowNestedRoot: true
    }) && testMatch(p, codeLike));

    const protectedControlPlaneFiles = normalizedFiles.filter((p: string) => testPathPrefix(p, classificationConfig.protected_control_plane_roots));
    const protectedControlPlaneChanged = protectedControlPlaneFiles.length > 0;

    const dbTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.db_trigger_regexes));
    const securityTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.security_trigger_regexes));
    const apiTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.api_trigger_regexes));
    const dependencyTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.dependency_trigger_regexes));
    const infraTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.infra_trigger_regexes));
    const testTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.test_trigger_regexes));
    const performancePathTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.performance_trigger_regexes));
    const sqlOrMigrationCount = normalizedFiles.filter((p: string) => testMatch(p, sqlOrMigration)).length;
    const onlySqlOrMigration = normalizedFiles.length > 0 && sqlOrMigrationCount === normalizedFiles.length;

    const refactorIntentTriggered = /\b(refactor|cleanup|restructure|extract|rename|modularization|simplify)\b/i.test(taskIntent);
    const codeLikeCount = normalizedFiles.filter((p: string) => testMatch(p, codeLike)).length;
    const runtimeCodeLikeCount = normalizedFiles.filter(
        (p: string) => matchesConfiguredRoot(p, runtimeRoots, { allowNestedRoot: true }) && testMatch(p, codeLike)
    ).length;

    const refactorHeuristicReasons = [];
    if (runtimeChanged && normalizedFiles.length > 0) {
        const renameRatio = normalizedFiles.length > 0 ? Math.round((renameCount / normalizedFiles.length) * 10000) / 10000 : 0;
        if (normalizedFiles.length >= 2 && renameRatio >= 0.4) {
            refactorHeuristicReasons.push('rename_ratio_high');
        }
        const totalChurn = additionsTotal + deletionsTotal;
        const deltaBalanceThreshold = Math.max(20, Math.floor(totalChurn * 0.15));
        const balancedChurn = Math.abs(additionsTotal - deletionsTotal) <= deltaBalanceThreshold;
        if (codeLikeCount >= 3 && totalChurn >= 80 && balancedChurn && !dbTriggered && !securityTriggered) {
            refactorHeuristicReasons.push('balanced_structural_churn');
        }
    }
    const refactorHeuristicTriggered = refactorHeuristicReasons.length > 0;
    const refactorTriggered = refactorIntentTriggered || refactorHeuristicTriggered;

    const performanceHeuristicTriggered = (
        !performancePathTriggered
        && (apiTriggered || (dbTriggered && runtimeCodeChanged))
        && !onlySqlOrMigration
        && changedLinesTotal >= performanceHeuristicMinLines
    );
    const performanceTriggered = performancePathTriggered || performanceHeuristicTriggered;

    const allUnderFastRoots = normalizedFiles.length > 0 && normalizedFiles.every((p: string) => matchesConfiguredRoot(p, fastPathRoots, {
        semanticPackageMatch: true
    }));
    const allFastAllowedTypes = normalizedFiles.length > 0 && normalizedFiles.every((p: string) => testMatch(p, fastPathAllowed));
    const hasFastSensitiveMatch = normalizedFiles.some((p: string) => testMatch(p, fastPathSensitive));

    const fastPathEligible = (
        runtimeChanged
        && allUnderFastRoots
        && allFastAllowedTypes
        && !hasFastSensitiveMatch
        && normalizedFiles.length <= fastPathMaxFiles
        && changedLinesTotal <= fastPathMaxChangedLines
    );

    let mode = 'FULL_PATH';
    if (fastPathEligible && !dbTriggered && !securityTriggered && !refactorTriggered
        && !apiTriggered && !dependencyTriggered && !infraTriggered && !performanceTriggered) {
        mode = 'FAST_PATH';
    }

    const requiredCodeReview = runtimeCodeChanged && mode === 'FULL_PATH';
    const requiredDbReview = dbTriggered;
    const requiredSecurityReview = securityTriggered;
    const requiredRefactorReview = refactorTriggered;
    const requiredApiReview = apiTriggered && !!reviewCapabilities.api;
    const requiredTestReview = testTriggered && !!reviewCapabilities.test;
    const requiredPerformanceReview = performanceTriggered && !!reviewCapabilities.performance;
    const requiredInfraReview = infraTriggered && !!reviewCapabilities.infra;
    const requiredDependencyReview = dependencyTriggered && !!reviewCapabilities.dependency;
    const zeroDiffDetected = normalizedFiles.length === 0 && changedLinesTotal === 0;

    const scopeClassification = classifyScopeCategory(normalizedFiles, codeLike, runtimeRoots);

    return {
        detection_source: detectionSource,
        mode,
        scope_category: scopeClassification.category,
        scope_category_reasons: scopeClassification.reasons,
        metrics: {
            classification_config_source: classificationConfig.source,
            classification_config_path: classificationConfig.config_path,
            changed_files_count: normalizedFiles.length,
            changed_lines_total: changedLinesTotal,
            additions_total: additionsTotal,
            deletions_total: deletionsTotal,
            rename_count: renameCount,
            code_like_changed_count: codeLikeCount,
            runtime_code_like_changed_count: runtimeCodeLikeCount,
            review_capabilities: reviewCapabilities,
            fast_path_max_files: fastPathMaxFiles,
            fast_path_max_changed_lines: fastPathMaxChangedLines,
            performance_heuristic_min_lines: performanceHeuristicMinLines
        },
        triggers: {
            runtime_changed: runtimeChanged,
            runtime_code_changed: runtimeCodeChanged,
            protected_control_plane_changed: protectedControlPlaneChanged,
            changed_protected_files: protectedControlPlaneFiles,
            db: dbTriggered,
            security: securityTriggered,
            api: apiTriggered,
            test: testTriggered,
            performance: performanceTriggered,
            infra: infraTriggered,
            dependency: dependencyTriggered,
            refactor: refactorTriggered,
            refactor_intent: refactorIntentTriggered,
            refactor_heuristic: refactorHeuristicTriggered,
            refactor_heuristic_reasons: refactorHeuristicReasons,
            performance_heuristic: performanceHeuristicTriggered,
            fast_path_eligible: fastPathEligible,
            fast_path_sensitive_match: hasFastSensitiveMatch
        },
        required_reviews: {
            code: requiredCodeReview,
            db: requiredDbReview,
            security: requiredSecurityReview,
            refactor: requiredRefactorReview,
            api: requiredApiReview,
            test: requiredTestReview,
            performance: requiredPerformanceReview,
            infra: requiredInfraReview,
            dependency: requiredDependencyReview
        },
        zero_diff_guard: {
            zero_diff_detected: zeroDiffDetected,
            status: zeroDiffDetected ? 'BASELINE_ONLY' : 'DIFF_PRESENT',
            completion_requires_audited_no_op: zeroDiffDetected,
            no_op_artifact_suffix: zeroDiffDetected ? '-no-op.json' : null,
            rationale: zeroDiffDetected
                ? 'Preflight on a clean workspace is baseline-only. Task completion requires a produced diff or an audited no-op artifact.'
                : 'Workspace diff detected.'
        },
        changed_files: normalizedFiles
    };
}
