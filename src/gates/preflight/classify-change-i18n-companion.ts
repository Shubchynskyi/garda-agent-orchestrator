import { matchAnyRegex } from '../../gate-runtime/text-utils';
import type { ResolvedClassificationConfig } from './classify-change-config';

export interface ChangedFileLineStats {
    additions: number;
    deletions: number;
    changed_lines: number;
}

export interface UiI18nCompanionScope {
    eligible: boolean;
    driverFiles: string[];
    i18nFiles: string[];
    effectiveChangedFilesCount: number;
    effectiveChangedLinesTotal: number | null;
    reason: string;
}

interface AnalyzeUiI18nCompanionScopeInput {
    normalizedFiles: string[];
    classificationConfig: ResolvedClassificationConfig;
    changedFileStats?: Record<string, ChangedFileLineStats>;
    maxDriverFiles: number;
    maxDriverChangedLines: number;
}

const UI_SURFACE_SEGMENTS = new Set([
    'frontend',
    'front-end',
    'web',
    'ui',
    'views',
    'view',
    'dashboard',
    'dashboards',
    'report',
    'reports',
    'mobile'
]);

const I18N_SEGMENTS = new Set([
    'i18n',
    'l10n',
    'locale',
    'locales',
    'lang',
    'langs',
    'language',
    'languages',
    'lang-pack',
    'lang-packs',
    'translation',
    'translations'
]);

function pathSegments(pathValue: string): string[] {
    return String(pathValue || '')
        .split('/')
        .map((segment) => segment.trim().toLowerCase())
        .filter(Boolean);
}

function hasAnySegment(pathValue: string, segments: ReadonlySet<string>): boolean {
    return pathSegments(pathValue).some((segment) => segments.has(segment));
}

function isJsonLikeI18nFile(pathValue: string): boolean {
    return /\.(json|jsonc)$/i.test(pathValue);
}

function isUiSurfacePath(pathValue: string, classificationConfig: ResolvedClassificationConfig): boolean {
    if (hasAnySegment(pathValue, UI_SURFACE_SEGMENTS)) {
        return true;
    }
    return pathSegments(pathValue).some((segment) => (
        classificationConfig.fast_path_roots.some((root) => {
            const token = root.replace(/\/+$/, '').toLowerCase();
            return token && token !== 'src' && segment === token;
        })
    ));
}

function isUiI18nPath(pathValue: string, classificationConfig: ResolvedClassificationConfig): boolean {
    return isJsonLikeI18nFile(pathValue)
        && hasAnySegment(pathValue, I18N_SEGMENTS)
        && isUiSurfacePath(pathValue, classificationConfig);
}

function isFastAllowedDriver(pathValue: string, classificationConfig: ResolvedClassificationConfig): boolean {
    return matchAnyRegex(pathValue, classificationConfig.fast_path_allowed_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function isFastSensitivePath(pathValue: string, classificationConfig: ResolvedClassificationConfig): boolean {
    return matchAnyRegex(pathValue, classificationConfig.fast_path_sensitive_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function sumDriverChangedLines(
    driverFiles: string[],
    changedFileStats?: Record<string, ChangedFileLineStats>
): number | null {
    if (!changedFileStats) {
        return null;
    }
    let total = 0;
    for (const filePath of driverFiles) {
        const stats = changedFileStats[filePath];
        if (!stats || typeof stats.changed_lines !== 'number' || stats.changed_lines < 0) {
            return null;
        }
        total += stats.changed_lines;
    }
    return total;
}

export function analyzeUiI18nCompanionScope(input: AnalyzeUiI18nCompanionScopeInput): UiI18nCompanionScope {
    const i18nFiles = input.normalizedFiles.filter((filePath) => isUiI18nPath(filePath, input.classificationConfig));
    const driverFiles = input.normalizedFiles.filter((filePath) => !i18nFiles.includes(filePath));
    const driverChangedLinesTotal = sumDriverChangedLines(driverFiles, input.changedFileStats);
    const baseResult = {
        driverFiles,
        i18nFiles,
        effectiveChangedFilesCount: driverFiles.length,
        effectiveChangedLinesTotal: driverChangedLinesTotal
    };

    if (i18nFiles.length === 0) {
        return { ...baseResult, eligible: false, reason: 'no_ui_i18n_files' };
    }
    if (driverFiles.length === 0) {
        return { ...baseResult, eligible: false, reason: 'standalone_i18n_scope' };
    }
    if (driverFiles.length > input.maxDriverFiles) {
        return { ...baseResult, eligible: false, reason: 'too_many_driver_files' };
    }
    if (driverChangedLinesTotal !== null && driverChangedLinesTotal > input.maxDriverChangedLines) {
        return { ...baseResult, eligible: false, reason: 'driver_changed_lines_exceed_fast_path' };
    }
    const allDriversAreUiSurface = driverFiles.every((filePath) => isUiSurfacePath(filePath, input.classificationConfig));
    if (!allDriversAreUiSurface) {
        return { ...baseResult, eligible: false, reason: 'driver_not_ui_surface' };
    }
    const allDriversAllowed = driverFiles.every((filePath) => isFastAllowedDriver(filePath, input.classificationConfig));
    if (!allDriversAllowed) {
        return { ...baseResult, eligible: false, reason: 'driver_type_not_fast_allowed' };
    }
    const hasSensitiveDriver = driverFiles.some((filePath) => isFastSensitivePath(filePath, input.classificationConfig));
    if (hasSensitiveDriver) {
        return { ...baseResult, eligible: false, reason: 'driver_sensitive_path' };
    }

    return { ...baseResult, eligible: true, reason: 'ui_i18n_companion_scope' };
}
