export function hasPerformanceSensitiveCacheIntent(taskIntent: string): boolean {
    return /\b(ttl|time-to-live|expir(?:y|ation|e)|evict(?:ion)?|lru|lfu|hit[-\s]?rate|miss[-\s]?rate|warm(?:up|-up)?|latency|throughput|performance|perf|benchmark|profil(?:e|ing)|redis|memcached|hot[-\s]?path|memory|size[-\s]?limit)\b/i.test(taskIntent);
}

export function hasRefactorIntent(taskIntent: string): boolean {
    return /\b(refactor|cleanup|restructure|extract|rename|modularization|modularize|decompose|simplify)\b/i.test(taskIntent)
        || /\bsplit\b.{0,80}\b(module|modules|component|components|renderer|renderers|helper|helpers|class|classes|function|functions)\b.{0,80}\b(out|from)\b/i.test(taskIntent)
        || /\bsplit\b.{0,80}\binto\b.{0,80}\b(module|modules|component|components|renderer|renderers|helper|helpers|class|classes|function|functions)\b/i.test(taskIntent);
}
