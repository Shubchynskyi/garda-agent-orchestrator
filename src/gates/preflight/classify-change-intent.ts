export function hasPerformanceSensitiveCacheIntent(taskIntent: string): boolean {
    return /\b(ttl|time-to-live|expir(?:y|ation|e)|evict(?:ion)?|lru|lfu|hit[-\s]?rate|miss[-\s]?rate|warm(?:up|-up)?|latency|throughput|performance|perf|benchmark|profil(?:e|ing)|redis|memcached|hot[-\s]?path|memory|size[-\s]?limit)\b/i.test(taskIntent);
}

export type SecurityReviewIntentReason =
    | 'explicit_security_follow_up_prefix'
    | 'explicit_security_review_request'
    | 'authorization_boundary_remediation'
    | 'trust_boundary_remediation'
    | 'adversarial_path_remediation'
    | 'path_containment_remediation'
    | 'security_sensitive_runtime_intent';

export interface SecurityReviewIntentClassification {
    triggered: boolean;
    reasons: SecurityReviewIntentReason[];
}

const STRUCTURED_SECURITY_FOLLOW_UP_PATTERN =
    /^\s*(?:\[\s*security\s*\]|security\s+follow[-\s]?up\s*:)/i;
const EXPLICIT_SECURITY_REVIEW_REQUEST_PATTERN =
    /\b(?:(?:require|request|mandate|enforce)\s+(?:an?\s+)?security\s+(?:review|lane)|security\s+(?:review|lane)\s+(?:is\s+)?(?:required|mandatory))\b/i;
const AUTHORIZATION_BOUNDARY_REMEDIATION_PATTERN =
    /(?:\b(?:authoriz(?:ation|e|ed|ing)|authz|access[-\s]?control|privilege)\b.{0,80}\b(?:boundar(?:y|ies)|enforce|check|deny|prevent|restrict|validate|verify|guard)\b|\b(?:boundar(?:y|ies)|enforce|check|deny|prevent|restrict|validate|verify|guard)\b.{0,80}\b(?:authoriz(?:ation|e|ed|ing)|authz|access[-\s]?control|privilege)\b)/i;
const TRUST_BOUNDARY_REMEDIATION_PATTERN = /\btrust[-\s]?boundar(?:y|ies)\b/i;
const ADVERSARIAL_PATH_REMEDIATION_PATTERN =
    /(?:\b(?:adversarial|untrusted)\s+paths?\b|\b(?:path|directory)\s+traversal\b|\bsymlink\s+escape\b|\bpath\s+injection\b|\b(?:reject|block|prevent|guard|validate)\b.{0,80}\bpath\s+aliases?\b)/i;
const PATH_CONTAINMENT_REMEDIATION_PATTERN =
    /(?:\boutside[-\s]?root\s+paths?\b|\bpath\s+containment\b|\bpaths?\b.{0,80}\b(?:contained|confined|bounded)\b.{0,40}\b(?:repository|workspace|project)\s+root\b|\b(?:escape|outside)\b.{0,40}\b(?:repository|workspace|project)\s+root\b|\bexternal\s+symlinks?\b)/i;
const LEGACY_SECURITY_RUNTIME_INTENT_PATTERN =
    /\b(webhook|oauth2?|openid|oidc|jwt|token|credential|credentials|secret|callback|callback ownership|telegram bot api|bot api|file[-\s]?download|download token|sanitize(?:d)?[-\s]?observability|secret[-\s]?safe[-\s]?observability|redact(?:ion)?|pii|auth(?:entication|orization)?)\b/i;

export function classifySecurityReviewIntent(taskIntent: string): SecurityReviewIntentClassification {
    const normalizedIntent = String(taskIntent || '').trim();
    const reasons: SecurityReviewIntentReason[] = [];

    if (STRUCTURED_SECURITY_FOLLOW_UP_PATTERN.test(normalizedIntent)) {
        reasons.push('explicit_security_follow_up_prefix');
    }
    if (EXPLICIT_SECURITY_REVIEW_REQUEST_PATTERN.test(normalizedIntent)) {
        reasons.push('explicit_security_review_request');
    }
    if (AUTHORIZATION_BOUNDARY_REMEDIATION_PATTERN.test(normalizedIntent)) {
        reasons.push('authorization_boundary_remediation');
    }
    if (TRUST_BOUNDARY_REMEDIATION_PATTERN.test(normalizedIntent)) {
        reasons.push('trust_boundary_remediation');
    }
    if (ADVERSARIAL_PATH_REMEDIATION_PATTERN.test(normalizedIntent)) {
        reasons.push('adversarial_path_remediation');
    }
    if (PATH_CONTAINMENT_REMEDIATION_PATTERN.test(normalizedIntent)) {
        reasons.push('path_containment_remediation');
    }
    const substantiveReasonFound = reasons.some((reason) =>
        reason !== 'explicit_security_follow_up_prefix'
        && reason !== 'explicit_security_review_request'
    );
    if (!substantiveReasonFound && LEGACY_SECURITY_RUNTIME_INTENT_PATTERN.test(normalizedIntent)) {
        reasons.push('security_sensitive_runtime_intent');
    }

    return {
        triggered: reasons.length > 0,
        reasons
    };
}

export function hasSecurityReviewIntent(taskIntent: string): boolean {
    return classifySecurityReviewIntent(taskIntent).triggered;
}

export function hasApiReviewIntent(taskIntent: string): boolean {
    return /\b(public webhook|webhook|callback|endpoint|route|handler|controller|request|response|dto|contract|openapi|swagger|graphql|telegram bot api|file[-\s]?download)\b/i.test(taskIntent);
}

export function hasPerformanceReviewIntent(taskIntent: string): boolean {
    return /\b(queue|worker|workers|job queue|retry[-\s]?storm|retry storm|backoff|throttle|rate[-\s]?limit|throughput|latency|concurrency|parallelism|pool|batch|bulkhead)\b/i.test(taskIntent);
}

export function hasRefactorIntent(taskIntent: string): boolean {
    return /\b(refactor|cleanup|restructure|extract|rename|modularization|modularize|decompose|simplify)\b/i.test(taskIntent)
        || /\bsplit\b.{0,80}\b(module|modules|component|components|renderer|renderers|helper|helpers|class|classes|function|functions)\b.{0,80}\b(out|from)\b/i.test(taskIntent)
        || /\bsplit\b.{0,80}\binto\b.{0,80}\b(module|modules|component|components|renderer|renderers|helper|helpers|class|classes|function|functions)\b/i.test(taskIntent);
}
