import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchAnyRegex } from '../gate-runtime/text-utils';
import {
    normalizePath,
    getProtectedControlPlaneRoots,
    normalizeProtectedControlPlaneRoots,
    normalizeRootPrefixes,
    orchestratorRelativePath,
    testPathPrefix,
    toPosix,
    toStringArray
} from './helpers';
import { resolveGateExecutionPath } from './isolation-sandbox';
import {
    getDefaultReviewCapabilities,
    readReviewCapabilitiesConfigFile,
    type ReviewCapabilities
} from '../core/review-capabilities';
import {
    buildReviewExecutionPolicySummaryLine,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import {
    DEFAULT_ORDINARY_DOC_PATHS,
    ORDINARY_DOC_PATHS_CONFIG_KEY,
    collectOrdinaryDocPathMatches,
    matchOrdinaryDocPathPattern,
    normalizeOrdinaryDocPathPatterns,
    type OrdinaryDocPathMatch
} from '../core/ordinary-doc-paths';

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
    ordinary_doc_paths: string[];
}

export interface ResolvedClassificationConfig {
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
    ordinary_doc_paths: string[];
}

interface MatchConfiguredRootOptions {
    allowNestedRoot?: boolean;
    semanticPackageMatch?: boolean;
}

export interface ClassifyChangeOptions {
    normalizedFiles?: string[];
    repoRoot?: string;
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
    reviewExecutionPolicyMode?: EffectiveReviewExecutionPolicyMode;
}

const WEAK_DB_SIGNAL_REGEXES = Object.freeze([
    '(Repository|Dao|Specification|Query|Migration)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$'
]);

const DB_PROJECT_EVIDENCE_PATHS = Object.freeze([
    'db',
    'database',
    'migrations',
    'prisma/schema.prisma',
    'src/db',
    'src/database',
    'src/migrations',
    'src/main/resources/db',
    'src/main/resources/database',
    'src/main/resources/migrations',
    'knexfile.js',
    'knexfile.ts',
    'ormconfig.js',
    'ormconfig.ts',
    'ormconfig.json',
    'sequelize.config.js',
    'sequelize.config.ts',
    'liquibase.properties',
    'flyway.conf',
    'alembic.ini'
]);

const DB_PACKAGE_NAMES = Object.freeze([
    '@prisma/client',
    'prisma',
    'typeorm',
    'knex',
    'sequelize',
    'mongoose',
    'mongodb',
    'pg',
    'mysql',
    'mysql2',
    'sqlite3',
    'better-sqlite3',
    'mariadb',
    'mssql'
]);

const DB_MANIFEST_MARKERS = Object.freeze([
    'alembic',
    'database',
    'diesel',
    'flyway',
    'gorm',
    'hibernate',
    'jdbc',
    'jooq',
    'jpa',
    'knex',
    'liquibase',
    'mongodb',
    'mongoose',
    'mybatis',
    'mysql',
    'postgres',
    'postgresql',
    'prisma',
    'psycopg',
    'r2dbc',
    'sequelize',
    'sqlalchemy',
    'sqlite',
    'spring-boot-starter-data-jpa',
    'typeorm'
]);

const DB_MANIFEST_FILES = Object.freeze([
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'requirements.txt',
    'requirements-dev.txt',
    'pyproject.toml',
    'poetry.lock',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'Gemfile.lock'
]);

const DB_MANIFEST_MAX_BYTES = 512 * 1024;

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
                '(Cache|Redis|Elasticsearch|Search|Query|Benchmark|Profiling)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$',
                '(^|/)(performance|perf|benchmark)/'
            ]
        },
        code_like_regexes: ['\\.(java|kt|kts|groovy|ts|tsx|js|jsx|cjs|mjs|cs|go|py|rb|php|rs)$'],
        protected_control_plane_roots: getProtectedControlPlaneRoots(repoRoot),
        ordinary_doc_paths: [...DEFAULT_ORDINARY_DOC_PATHS]
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
                'sql_or_migration_regexes', 'code_like_regexes', 'protected_control_plane_roots',
                ORDINARY_DOC_PATHS_CONFIG_KEY
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

    const ordinaryDocPaths = normalizeOrdinaryDocPathPatterns(
        defaults.ordinary_doc_paths,
        `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
        { allowScalar: true }
    );

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
        protected_control_plane_roots: normalizeProtectedControlPlaneRoots(toStringArray(defaults.protected_control_plane_roots)),
        ordinary_doc_paths: ordinaryDocPaths
    };
}

/**
 * Load review capabilities from config file.
 */
export function getReviewCapabilities(repoRoot: string): ReviewCapabilities {
    const configPath = resolveGateExecutionPath(repoRoot, 'live/config/review-capabilities.json');
    try {
        return readReviewCapabilitiesConfigFile(configPath);
    } catch {
        return getDefaultReviewCapabilities();
    }
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

function readPackageJsonDatabaseEvidence(repoRoot: string): string[] {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return [];
    }

    try {
        const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const packageNames = new Set<string>();
        for (const sectionName of dependencySections) {
            const section = raw[sectionName];
            if (!section || typeof section !== 'object') {
                continue;
            }
            for (const packageName of Object.keys(section as Record<string, unknown>)) {
                packageNames.add(packageName.toLowerCase());
            }
        }
        return DB_PACKAGE_NAMES
            .filter((packageName) => packageNames.has(packageName.toLowerCase()))
            .map((packageName) => `package:${packageName}`);
    } catch {
        return [];
    }
}

function readManifestDatabaseEvidence(rootPath: string, relativeRoot: string, manifestFile: string): string[] {
    const manifestPath = path.join(rootPath, manifestFile);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }

    try {
        const stat = fs.statSync(manifestPath);
        if (!stat.isFile() || stat.size > DB_MANIFEST_MAX_BYTES) {
            return [];
        }
        const content = fs.readFileSync(manifestPath, 'utf8').toLowerCase();
        const matchedMarkers = DB_MANIFEST_MARKERS.filter((marker) => content.includes(marker));
        if (matchedMarkers.length === 0) {
            return [];
        }
        const evidencePath = normalizePath(relativeRoot ? `${relativeRoot}/${manifestFile}` : manifestFile);
        return matchedMarkers.map((marker) => `${evidencePath}:${marker}`);
    } catch {
        return [];
    }
}

function collectCandidateDatabaseEvidenceRoots(normalizedFiles: string[]): string[] {
    const roots = new Set<string>(['']);
    for (const filePath of normalizedFiles) {
        const normalizedPath = normalizePath(filePath);
        const parts = normalizedPath.split('/').filter(Boolean);
        parts.pop();
        for (let index = 1; index <= parts.length; index++) {
            roots.add(parts.slice(0, index).join('/'));
        }
    }
    return [...roots].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function collectDatabaseProjectEvidence(repoRoot?: string, normalizedFiles: string[] = []): string[] {
    if (!repoRoot) {
        return [];
    }

    const evidence = new Set<string>();
    for (const relativeRoot of collectCandidateDatabaseEvidenceRoots(normalizedFiles)) {
        const rootPath = path.join(repoRoot, relativeRoot);
        if (!fs.existsSync(rootPath)) {
            continue;
        }
        for (const relativePath of DB_PROJECT_EVIDENCE_PATHS) {
            const evidencePath = relativeRoot ? `${relativeRoot}/${relativePath}` : relativePath;
            if (fs.existsSync(path.join(rootPath, relativePath))) {
                evidence.add(normalizePath(evidencePath));
            }
        }
        for (const dependencyEvidence of readPackageJsonDatabaseEvidence(rootPath)) {
            evidence.add(relativeRoot ? `${relativeRoot}/${dependencyEvidence}` : dependencyEvidence);
        }
        for (const manifestFile of DB_MANIFEST_FILES) {
            for (const manifestEvidence of readManifestDatabaseEvidence(rootPath, relativeRoot, manifestFile)) {
                evidence.add(manifestEvidence);
            }
        }
    }
    return [...evidence].sort();
}

function isConfiguredWeakDatabaseSignal(pathValue: string, dbTriggerRegexes: string[]): boolean {
    const configuredWeakRegexes = dbTriggerRegexes.filter((regex) => WEAK_DB_SIGNAL_REGEXES.includes(regex));
    return configuredWeakRegexes.length > 0 && matchAnyRegex(normalizePath(pathValue), configuredWeakRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function isStrongDatabaseChangedScope(pathValue: string, sqlOrMigrationRegexes: string[], dbTriggerRegexes: string[]): boolean {
    const normalizedPath = normalizePath(pathValue);
    const configuredStrongRegexes = dbTriggerRegexes.filter((regex) => !WEAK_DB_SIGNAL_REGEXES.includes(regex));
    const strongRegexes = configuredStrongRegexes.filter((regex) => sqlOrMigrationRegexes.includes(regex) || dbTriggerRegexes.includes(regex));
    return matchAnyRegex(normalizedPath, strongRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function hasPerformanceSensitiveCacheIntent(taskIntent: string): boolean {
    return /\b(ttl|time-to-live|expir(?:y|ation|e)|evict(?:ion)?|lru|lfu|hit[-\s]?rate|miss[-\s]?rate|warm(?:up|-up)?|latency|throughput|performance|perf|benchmark|profil(?:e|ing)|redis|memcached|hot[-\s]?path|memory|size[-\s]?limit)\b/i.test(taskIntent);
}

function isOrdinaryOrchestratorCacheMaintenancePath(pathValue: string): boolean {
    const normalizedPath = normalizePath(pathValue).replace(/^garda-agent-orchestrator\//, '');
    return normalizedPath === 'src/gates/workspace-snapshot-cache.ts'
        || normalizedPath === 'src/gates/protected-hash-cache.ts';
}

export function isDocumentationLikePath(pathValue: string, ordinaryDocPaths: string[] = []): boolean {
    const normalizedPath = normalizePath(pathValue);
    return testPrecompiled(normalizedPath, DOC_LIKE_COMPILED)
        || matchOrdinaryDocPathPattern(normalizedPath, ordinaryDocPaths) !== null;
}

export function isRuntimeCodeLikePath(pathValue: string, codeLikeRegexes: string[], runtimeRoots: string[]): boolean {
    const normalizedPath = normalizePath(pathValue);
    return matchAnyRegex(normalizedPath, codeLikeRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    }) && matchesConfiguredRoot(normalizedPath, runtimeRoots, { allowNestedRoot: true });
}

export type ScopeCategory = 'code' | 'docs-only' | 'test-only' | 'config-only' | 'audit-only' | 'mixed' | 'empty';

interface ScopeCategoryOptions {
    ordinaryDocPaths?: string[];
    protectedControlPlaneRoots?: string[];
    testTriggerRegexes?: string[];
    sqlOrMigrationRegexes?: string[];
    dbTriggerRegexes?: string[];
    securityTriggerRegexes?: string[];
    apiTriggerRegexes?: string[];
    dependencyTriggerRegexes?: string[];
}

interface SafeOrdinaryDocumentationPathConfig {
    code_like_regexes: string[];
    runtime_roots: string[];
    protected_control_plane_roots: string[];
    ordinary_doc_paths: string[];
    sql_or_migration_regexes?: string[];
    db_trigger_regexes?: string[];
    security_trigger_regexes?: string[];
    api_trigger_regexes?: string[];
    dependency_trigger_regexes?: string[];
}

/**
 * Classify the scope category from changed files.
 *
 * Categories:
 * - `code`: at least one code-like file under runtime roots
 * - `docs-only`: all files match documentation patterns
 * - `test-only`: all files match configured test-scope patterns
 * - `config-only`: all files match config/infra patterns (no code)
 * - `audit-only`: all files are orchestrator control-plane artifacts
 * - `mixed`: mix of code and non-code files
 * - `empty`: no changed files
 */
export function classifyScopeCategory(
    normalizedFiles: string[],
    codeLikeRegexes: string[],
    runtimeRoots: string[],
    options: ScopeCategoryOptions = {}
): { category: ScopeCategory; reasons: string[] } {
    if (normalizedFiles.length === 0) {
        return { category: 'empty', reasons: ['no_changed_files'] };
    }

    let codeCount = 0;
    let docCount = 0;
    let testCount = 0;
    let configCount = 0;
    let auditCount = 0;

    for (const file of normalizedFiles) {
        const isCode = isRuntimeCodeLikePath(file, codeLikeRegexes, runtimeRoots);
        const isTest = matchAnyRegex(file, options.testTriggerRegexes || [], {
            skipInvalidRegex: true,
            caseInsensitive: true
        });
        const isConfig = testPrecompiled(file, CONFIG_LIKE_COMPILED);
        const isAudit = testPrecompiled(file, AUDIT_ONLY_COMPILED);
        const isProtectedControlPlane = testPathPrefix(file, options.protectedControlPlaneRoots || []);
        if (isAudit || isProtectedControlPlane) {
            auditCount++;
            continue;
        }
        if (isConfig) {
            configCount++;
            continue;
        }
        if (isSafeOrdinaryDocumentationPath(file, {
            code_like_regexes: codeLikeRegexes,
            runtime_roots: runtimeRoots,
            protected_control_plane_roots: options.protectedControlPlaneRoots || [],
            ordinary_doc_paths: options.ordinaryDocPaths || [],
            sql_or_migration_regexes: options.sqlOrMigrationRegexes || [],
            db_trigger_regexes: options.dbTriggerRegexes || [],
            security_trigger_regexes: options.securityTriggerRegexes || [],
            api_trigger_regexes: options.apiTriggerRegexes || [],
            dependency_trigger_regexes: options.dependencyTriggerRegexes || []
        })) {
            docCount++;
            continue;
        }
        if (isTest) {
            testCount++;
            continue;
        }
        if (isCode) {
            codeCount++;
            continue;
        }
        codeCount++; // unknown files default to code for safety
    }

    const total = normalizedFiles.length;
    const reasons: string[] = [];

    if (codeCount > 0) {
        if (docCount > 0 || testCount > 0 || configCount > 0 || auditCount > 0) {
            reasons.push(`code=${codeCount}`, `docs=${docCount}`, `tests=${testCount}`, `config=${configCount}`, `audit=${auditCount}`);
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

    if (testCount === total) {
        reasons.push(`test_only_files=${testCount}`);
        return { category: 'test-only', reasons };
    }

    if (configCount === total) {
        reasons.push(`config_only_files=${configCount}`);
        return { category: 'config-only', reasons };
    }

    // Mix of non-code categories (e.g., docs + config)
    if (docCount > 0) reasons.push(`docs=${docCount}`);
    if (testCount > 0) reasons.push(`tests=${testCount}`);
    if (configCount > 0) reasons.push(`config=${configCount}`);
    if (auditCount > 0) reasons.push(`audit=${auditCount}`);
    return { category: 'docs-only', reasons: [...reasons, 'all_non_code'] };
}

function matchesSensitiveOrdinaryDocTrigger(
    filePath: string,
    config: SafeOrdinaryDocumentationPathConfig
): boolean {
    const triggerRegexes = [
        ...(config.sql_or_migration_regexes || []),
        ...(config.db_trigger_regexes || []),
        ...(config.security_trigger_regexes || []),
        ...(config.api_trigger_regexes || []),
        ...(config.dependency_trigger_regexes || [])
    ];
    if (triggerRegexes.length === 0) {
        return false;
    }
    return matchAnyRegex(filePath, triggerRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

export function isSafeOrdinaryDocumentationPath(
    filePath: string,
    config: SafeOrdinaryDocumentationPathConfig
): boolean {
    const normalizedPath = normalizePath(filePath);
    if (isRuntimeCodeLikePath(normalizedPath, config.code_like_regexes, config.runtime_roots)
        || testPrecompiled(normalizedPath, AUDIT_ONLY_COMPILED)
        || testPathPrefix(normalizedPath, config.protected_control_plane_roots)
        || testPrecompiled(normalizedPath, CONFIG_LIKE_COMPILED)
        || matchesSensitiveOrdinaryDocTrigger(normalizedPath, config)
    ) {
        return false;
    }
    return testPrecompiled(normalizedPath, DOC_LIKE_COMPILED)
        || matchOrdinaryDocPathPattern(normalizedPath, config.ordinary_doc_paths) !== null;
}

function getSafeOrdinaryDocPathMatches(
    normalizedFiles: string[],
    classificationConfig: ResolvedClassificationConfig
): OrdinaryDocPathMatch[] {
    const candidateFiles = normalizedFiles.filter((filePath) => {
        const normalizedPath = normalizePath(filePath);
        return !isRuntimeCodeLikePath(
            normalizedPath,
            classificationConfig.code_like_regexes,
            classificationConfig.runtime_roots
        )
            && !testPrecompiled(normalizedPath, AUDIT_ONLY_COMPILED)
            && !testPathPrefix(normalizedPath, classificationConfig.protected_control_plane_roots)
            && !testPrecompiled(normalizedPath, CONFIG_LIKE_COMPILED)
            && !matchesSensitiveOrdinaryDocTrigger(normalizedPath, classificationConfig);
    });
    return collectOrdinaryDocPathMatches(
        candidateFiles,
        classificationConfig.ordinary_doc_paths
    )
        .filter((match) => isSafeOrdinaryDocumentationPath(match.path, classificationConfig));
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
    const reviewExecutionPolicyMode = options.reviewExecutionPolicyMode;

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
    }) && testMatch(p, codeLike) && !testMatch(p, classificationConfig.test_trigger_regexes));

    const protectedControlPlaneFiles = normalizedFiles.filter((p: string) => testPathPrefix(p, classificationConfig.protected_control_plane_roots));
    const protectedControlPlaneChanged = protectedControlPlaneFiles.length > 0;

    const dbStrongChangedFiles = normalizedFiles.filter((p: string) => (
        isStrongDatabaseChangedScope(p, sqlOrMigration, classificationConfig.db_trigger_regexes)
    ));
    const dbWeakSignalFiles = normalizedFiles.filter((p: string) => (
        dbStrongChangedFiles.indexOf(p) === -1
        && isConfiguredWeakDatabaseSignal(p, classificationConfig.db_trigger_regexes)
    ));
    const dbProjectEvidence = collectDatabaseProjectEvidence(options.repoRoot, normalizedFiles);
    const dbTriggered = dbStrongChangedFiles.length > 0
        || (dbWeakSignalFiles.length > 0 && dbProjectEvidence.length > 0);
    const securityTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.security_trigger_regexes));
    const apiTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.api_trigger_regexes));
    const dependencyTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.dependency_trigger_regexes));
    const infraTriggered = normalizedFiles.some((p: string) => testMatch(p, classificationConfig.infra_trigger_regexes));
    const ordinaryDocPathMatches = getSafeOrdinaryDocPathMatches(normalizedFiles, classificationConfig);
    const ordinaryDocPathMatchedFiles = [...new Set(ordinaryDocPathMatches.map((entry) => entry.path))].sort();
    const safeOrdinaryDocFiles = ordinaryDocPathMatchedFiles;
    const testOrdinaryDocSuppressedFiles = safeOrdinaryDocFiles.filter((p: string) => testMatch(p, classificationConfig.test_trigger_regexes));
    const testTriggered = normalizedFiles.some((p: string) => (
        testMatch(p, classificationConfig.test_trigger_regexes)
        && !safeOrdinaryDocFiles.includes(p)
    ));
    const performancePathMatchedFiles = normalizedFiles.filter((p: string) => testMatch(p, classificationConfig.performance_trigger_regexes));
    const ordinaryCacheMaintenanceFiles = performancePathMatchedFiles.filter(isOrdinaryOrchestratorCacheMaintenancePath);
    const performanceCacheIntent = ordinaryCacheMaintenanceFiles.length > 0 && hasPerformanceSensitiveCacheIntent(taskIntent);
    const performancePathTriggeredFiles = performancePathMatchedFiles.filter((p: string) => (
        !isOrdinaryOrchestratorCacheMaintenancePath(p) || performanceCacheIntent
    ));
    const performanceCacheSuppressedFiles = performanceCacheIntent
        ? []
        : ordinaryCacheMaintenanceFiles;
    const performancePathTriggered = performancePathTriggeredFiles.length > 0;
    const sqlOrMigrationCount = normalizedFiles.filter((p: string) => testMatch(p, sqlOrMigration)).length;
    const onlySqlOrMigration = normalizedFiles.length > 0 && sqlOrMigrationCount === normalizedFiles.length;

    const refactorIntentTriggered = /\b(refactor|cleanup|restructure|extract|rename|modularization|simplify)\b/i.test(taskIntent);
    const codeLikeCount = normalizedFiles.filter((p: string) => testMatch(p, codeLike)).length;
    const runtimeCodeLikeCount = normalizedFiles.filter(
        (p: string) => matchesConfiguredRoot(p, runtimeRoots, { allowNestedRoot: true })
            && testMatch(p, codeLike)
            && !testMatch(p, classificationConfig.test_trigger_regexes)
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
        if (runtimeCodeLikeCount >= 3 && totalChurn >= 80 && balancedChurn && !dbTriggered && !securityTriggered) {
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
            db_strong_changed_files: dbStrongChangedFiles,
            db_weak_signal_files: dbWeakSignalFiles,
            db_project_evidence: dbProjectEvidence,
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
            ordinary_doc_path_matches: ordinaryDocPathMatches,
            ordinary_doc_path_matched_files: ordinaryDocPathMatchedFiles,
            ordinary_doc_path_patterns: classificationConfig.ordinary_doc_paths,
            test_ordinary_doc_suppressed_files: testOrdinaryDocSuppressedFiles,
            performance_path_changed_files: performancePathTriggeredFiles,
            performance_cache_candidate_files: ordinaryCacheMaintenanceFiles,
            performance_cache_intent: performanceCacheIntent,
            performance_cache_suppressed_files: performanceCacheSuppressedFiles,
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
        changed_files: normalizedFiles
    };
}
