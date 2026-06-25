export function hasPerformanceSensitiveCacheIntent(taskIntent: string): boolean {
    return /\b(ttl|time-to-live|expir(?:y|ation|e)|evict(?:ion)?|lru|lfu|hit[-\s]?rate|miss[-\s]?rate|warm(?:up|-up)?|latency|throughput|performance|perf|benchmark|profil(?:e|ing)|redis|memcached|hot[-\s]?path|memory|size[-\s]?limit)\b/i.test(taskIntent);
}

export function hasSecurityReviewIntent(taskIntent: string): boolean {
    return /\b(webhook|oauth2?|openid|oidc|jwt|token|credential|credentials|secret|callback|callback ownership|telegram bot api|bot api|file[-\s]?download|download token|sanitize(?:d)?[-\s]?observability|secret[-\s]?safe[-\s]?observability|redact(?:ion)?|pii|auth(?:entication|orization)?)\b/i.test(taskIntent);
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
