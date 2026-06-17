import type { LocalUiLocalizedText } from '../ui-language-pack-loader';
import { buildInitSettingTextCatalog, listInitSettingTextCatalogIds } from './catalog';

export interface InitSettingTextValidationIssue {
    languageId: string;
    path: string;
    reason: string;
}

function englishFieldMatches(
    languageId: string,
    path: string,
    actual: string | undefined,
    expected: string | undefined,
    field: string,
    issues: InitSettingTextValidationIssue[]
): void {
    if (languageId === 'en' || !expected?.trim()) {
        return;
    }
    if (actual === expected) {
        issues.push({ languageId, path: `${path}.${field}`, reason: `${field} still matches English source` });
    }
}

export function validateInitSettingTextPack(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildInitSettingTextCatalog()
): InitSettingTextValidationIssue[] {
    const issues: InitSettingTextValidationIssue[] = [];
    const catalogIds = listInitSettingTextCatalogIds(catalog);
    const packIds = Object.keys(pack).sort();

    for (const settingId of catalogIds) {
        if (!packIds.includes(settingId)) {
            issues.push({ languageId, path: settingId, reason: 'missing init setting translation' });
            continue;
        }
        const expected = catalog[settingId];
        const actual = pack[settingId];
        if (expected.label && !actual.label?.trim()) {
            issues.push({ languageId, path: `${settingId}.label`, reason: 'empty label' });
        }
        if (expected.description && !actual.description?.trim()) {
            issues.push({ languageId, path: `${settingId}.description`, reason: 'empty description' });
        }
        if (expected.title && !actual.title?.trim()) {
            issues.push({ languageId, path: `${settingId}.title`, reason: 'empty title' });
        }
        englishFieldMatches(languageId, settingId, actual.label, expected.label, 'label', issues);
        englishFieldMatches(languageId, settingId, actual.description, expected.description, 'description', issues);
        englishFieldMatches(languageId, settingId, actual.title, expected.title, 'title', issues);
    }

    for (const extraId of packIds) {
        if (!catalogIds.includes(extraId)) {
            issues.push({ languageId, path: extraId, reason: 'unexpected extra init setting translation' });
        }
    }

    return issues;
}

export function assertInitSettingTextPackComplete(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildInitSettingTextCatalog()
): void {
    const issues = validateInitSettingTextPack(languageId, pack, catalog);
    if (issues.length > 0) {
        const summary = issues
            .slice(0, 12)
            .map((issue) => `${issue.path}: ${issue.reason}`)
            .join('; ');
        throw new Error(`Init setting text pack '${languageId}' is incomplete (${issues.length} issue(s)). ${summary}`);
    }
}
