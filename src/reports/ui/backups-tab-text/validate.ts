import type { LocalUiLocalizedText } from '../ui-language-pack-loader';
import { buildBackupsTabTextCatalog, listBackupsTabTextCatalogIds } from './catalog';

export interface BackupsTabTextValidationIssue {
    languageId: string;
    path: string;
    reason: string;
}

const ENGLISH_LABEL_MATCH_EXEMPT_IDS = new Set([
    'id_column',
    'reason_update',
    'reason_scheduled'
]);

function shouldSkipEnglishLabelCheck(entryId: string, expected: string | undefined): boolean {
    return ENGLISH_LABEL_MATCH_EXEMPT_IDS.has(entryId) || Boolean(expected && /^[A-Z0-9-]{1,4}$/u.test(expected));
}

function englishFieldMatches(
    languageId: string,
    path: string,
    actual: string | undefined,
    expected: string | undefined,
    field: string,
    issues: BackupsTabTextValidationIssue[]
): void {
    if (languageId === 'en' || !expected?.trim()) {
        return;
    }
    if (field === 'label' && shouldSkipEnglishLabelCheck(path, expected)) {
        return;
    }
    if (actual === expected) {
        issues.push({ languageId, path: `${path}.${field}`, reason: `${field} still matches English source` });
    }
}

export function validateBackupsTabTextPack(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildBackupsTabTextCatalog()
): BackupsTabTextValidationIssue[] {
    const issues: BackupsTabTextValidationIssue[] = [];
    const catalogIds = listBackupsTabTextCatalogIds(catalog);
    const packIds = Object.keys(pack).sort();

    for (const entryId of catalogIds) {
        if (!packIds.includes(entryId)) {
            issues.push({ languageId, path: entryId, reason: 'missing backups tab translation' });
            continue;
        }
        const expected = catalog[entryId];
        const actual = pack[entryId];
        if (expected.label && !actual.label?.trim()) {
            issues.push({ languageId, path: `${entryId}.label`, reason: 'empty label' });
        }
        if (expected.description && !actual.description?.trim()) {
            issues.push({ languageId, path: `${entryId}.description`, reason: 'empty description' });
        }
        englishFieldMatches(languageId, entryId, actual.label, expected.label, 'label', issues);
        englishFieldMatches(languageId, entryId, actual.description, expected.description, 'description', issues);
    }

    for (const extraId of packIds) {
        if (!catalogIds.includes(extraId)) {
            issues.push({ languageId, path: extraId, reason: 'unexpected extra backups tab translation' });
        }
    }

    return issues;
}

export function assertBackupsTabTextPackComplete(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildBackupsTabTextCatalog()
): void {
    const issues = validateBackupsTabTextPack(languageId, pack, catalog);
    if (issues.length > 0) {
        const summary = issues
            .slice(0, 12)
            .map((issue) => `${issue.path}: ${issue.reason}`)
            .join('; ');
        throw new Error(`Backups tab text pack '${languageId}' is incomplete (${issues.length} issue(s)). ${summary}`);
    }
}
