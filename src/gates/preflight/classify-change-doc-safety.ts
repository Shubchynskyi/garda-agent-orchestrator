import {
    collectOrdinaryDocPathMatches,
    matchOrdinaryDocPathPattern,
    type OrdinaryDocPathMatch
} from '../../core/ordinary-doc-paths';
import { matchAnyRegex } from '../../gate-runtime/text-utils';
import { normalizePath, testPathPrefix } from '../shared/helpers';
import {
    matchesConfiguredRoot,
    type ResolvedClassificationConfig
} from './classify-change-config';

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

// Pre-compiled regex arrays to avoid recompilation per file.
const DOC_LIKE_COMPILED = DOC_LIKE_REGEXES.map((p) => new RegExp(p, 'i'));
const CONFIG_LIKE_COMPILED = CONFIG_LIKE_REGEXES.map((p) => new RegExp(p, 'i'));
const AUDIT_ONLY_COMPILED = AUDIT_ONLY_REGEXES.map((p) => new RegExp(p, 'i'));

function testPrecompiled(value: string, patterns: RegExp[]): boolean {
    return patterns.some((re) => re.test(value));
}

export interface SafeOrdinaryDocumentationPathConfig {
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

export function isOrdinaryOrchestratorCacheMaintenancePath(pathValue: string): boolean {
    const normalizedPath = normalizePath(pathValue).replace(/^garda-agent-orchestrator\//, '');
    return normalizedPath === 'src/gates/workspace/workspace-snapshot-cache.ts'
        || normalizedPath === 'src/gates/protected-control-plane/protected-hash-cache.ts';
}

export function isDocumentationLikePath(pathValue: string, ordinaryDocPaths: string[] = []): boolean {
    const normalizedPath = normalizePath(pathValue);
    return testPrecompiled(normalizedPath, DOC_LIKE_COMPILED)
        || matchOrdinaryDocPathPattern(normalizedPath, ordinaryDocPaths) !== null;
}

export function isConfigLikePath(pathValue: string): boolean {
    return testPrecompiled(normalizePath(pathValue), CONFIG_LIKE_COMPILED);
}

export function isAuditOnlyPath(pathValue: string): boolean {
    return testPrecompiled(normalizePath(pathValue), AUDIT_ONLY_COMPILED);
}

export function isRuntimeCodeLikePath(pathValue: string, codeLikeRegexes: string[], runtimeRoots: string[]): boolean {
    const normalizedPath = normalizePath(pathValue);
    return matchAnyRegex(normalizedPath, codeLikeRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    }) && matchesConfiguredRoot(normalizedPath, runtimeRoots, { allowNestedRoot: true });
}

export function isProtectedControlPlaneDocumentationSurfacePath(
    pathValue: string,
    config: SafeOrdinaryDocumentationPathConfig
): boolean {
    const normalizedPath = normalizePath(pathValue);
    const isDocsSurface = normalizedPath.startsWith('docs/')
        || normalizedPath.includes('/docs/');
    return isDocsSurface
        && isDocumentationLikePath(normalizedPath, config.ordinary_doc_paths)
        && !isRuntimeCodeLikePath(normalizedPath, config.code_like_regexes, config.runtime_roots)
        && !isConfigLikePath(normalizedPath)
        && !matchesSensitiveOrdinaryDocTrigger(normalizedPath, config);
}

export function isSecuritySensitiveDocumentationScopePath(
    pathValue: string,
    config: SafeOrdinaryDocumentationPathConfig
): boolean {
    const normalizedPath = normalizePath(pathValue);
    return testPrecompiled(normalizedPath, DOC_LIKE_COMPILED)
        && !isRuntimeCodeLikePath(normalizedPath, config.code_like_regexes, config.runtime_roots)
        && !isAuditOnlyPath(normalizedPath)
        && !testPathPrefix(normalizedPath, config.protected_control_plane_roots)
        && !isConfigLikePath(normalizedPath)
        && matchAnyRegex(normalizedPath, config.security_trigger_regexes || [], {
            skipInvalidRegex: true,
            caseInsensitive: true
        });
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
        || isAuditOnlyPath(normalizedPath)
        || testPathPrefix(normalizedPath, config.protected_control_plane_roots)
        || isConfigLikePath(normalizedPath)
        || matchesSensitiveOrdinaryDocTrigger(normalizedPath, config)
    ) {
        return false;
    }
    return testPrecompiled(normalizedPath, DOC_LIKE_COMPILED)
        || matchOrdinaryDocPathPattern(normalizedPath, config.ordinary_doc_paths) !== null;
}

export function getSafeOrdinaryDocPathMatches(
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
            && !isAuditOnlyPath(normalizedPath)
            && !testPathPrefix(normalizedPath, classificationConfig.protected_control_plane_roots)
            && !isConfigLikePath(normalizedPath)
            && !matchesSensitiveOrdinaryDocTrigger(normalizedPath, classificationConfig);
    });
    return collectOrdinaryDocPathMatches(
        candidateFiles,
        classificationConfig.ordinary_doc_paths
    )
        .filter((match) => isSafeOrdinaryDocumentationPath(match.path, classificationConfig));
}
