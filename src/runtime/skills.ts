// Re-export manifest parsing and index loading from focused modules so
// existing consumers that import from 'runtime/skills' keep working.
export {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    normalizeStringArray,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeNonNegativeInteger,
    getPackTemplateRoot,
    readPackManifest,
    readSkillManifest,
    readBaselineSkillManifest,
    collectMissingReferenceIssues,
    listPackSkillDefinitions,
    listBuiltinSkillPacks,
    getBuiltinSkillPackDefinition
} from './skill-manifest';
export type {
    SkillPackManifestDefinition,
    SkillManifestDefinition,
    BaselineSkillManifestDefinition,
    ManifestWithReferences,
    BuiltinSkillPackDefinition
} from './skill-manifest';

export {
    SKILLS_INDEX_VERSION,
    getSkillsIndexConfigPath,
    buildSkillsIndex,
    writeSkillsIndex,
    readSkillsIndex,
    validateSkillsIndex
} from './skill-index';
export type {
    SkillsIndexPackEntry,
    SkillsIndexSkillEntry,
    SkillsIndexPayload,
    SkillsIndexData
} from './skill-index';

// Re-export skill resolution (fuzzy alias, scoring, suggestion, dedupe)
// from the focused module so callers importing 'runtime/skills' keep working.
export {
    FUZZY_ALIAS_GROUPS,
    getFuzzyAliasMap,
    containsAtWordBoundary,
    getSignalFuzzyVariants,
    textMatchesFuzzyVariant,
    MATCH_CATEGORIES,
    hasDistinctSignalCoverage,
    dedupeSkillsByPack,
    suggestSkills
} from './skill-resolution';
export type {
    SignalMatches,
    SkillSuggestion
} from './skill-resolution';

// Re-export skill activation (review capabilities, installed packs CRUD,
// pack listing, add/remove, validation) from the focused module.
export {
    getSkillPacksConfigPath,
    getReviewCapabilitiesConfigPath,
    syncReviewCapabilities,
    readInstalledSkillPacks,
    writeInstalledSkillPacks,
    listSkillPacks,
    addSkillPack,
    removeSkillPack,
    validateSkillPacks
} from './skill-activation';

// Re-export skill telemetry (event types, emit helpers, typed event
// builders) from the focused module so callers importing 'runtime/skills'
// can access telemetry without knowing the internal module layout.
export {
    SKILL_TELEMETRY_EVENT_TYPES,
    SKILL_TELEMETRY_ACTOR,
    buildSkillTelemetryDetails,
    emitSkillTelemetryEvent,
    emitSkillTelemetryEventAsync,
    emitSkillSuggestedEvent,
    emitSkillSelectedEvent,
    emitSkillSelectedEventAsync,
    emitSkillReferenceLoadedEvent,
    emitSkillReferenceLoadedEventAsync
} from './skill-telemetry';
