import type { LocalUiLocalizedText } from '../ui-language-pack-loader';
import { buildProjectMemoryStatusTextCatalog, listProjectMemoryStatusTextCatalogIds } from './catalog';

export interface ProjectMemoryStatusTextValidationIssue {
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
    issues: ProjectMemoryStatusTextValidationIssue[]
): void {
    if (languageId === 'en' || !expected?.trim()) {
        return;
    }
    if (actual === expected) {
        issues.push({ languageId, path: `${path}.${field}`, reason: `${field} still matches English source` });
    }
}

export function validateProjectMemoryStatusTextPack(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildProjectMemoryStatusTextCatalog()
): ProjectMemoryStatusTextValidationIssue[] {
    const issues: ProjectMemoryStatusTextValidationIssue[] = [];
    const catalogIds = listProjectMemoryStatusTextCatalogIds(catalog);
    const packIds = Object.keys(pack).sort();

    for (const statusId of catalogIds) {
        if (!packIds.includes(statusId)) {
            issues.push({ languageId, path: statusId, reason: 'missing project memory status translation' });
            continue;
        }
        const expected = catalog[statusId];
        const actual = pack[statusId];
        if (expected.label && !actual.label?.trim()) {
            issues.push({ languageId, path: `${statusId}.label`, reason: 'empty label' });
        }
        if (expected.description && !actual.description?.trim()) {
            issues.push({ languageId, path: `${statusId}.description`, reason: 'empty description' });
        }
        englishFieldMatches(languageId, statusId, actual.label, expected.label, 'label', issues);
        englishFieldMatches(languageId, statusId, actual.description, expected.description, 'description', issues);
    }

    for (const extraId of packIds) {
        if (!catalogIds.includes(extraId)) {
            issues.push({ languageId, path: extraId, reason: 'unexpected extra project memory status translation' });
        }
    }

    return issues;
}

export function assertProjectMemoryStatusTextPackComplete(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildProjectMemoryStatusTextCatalog()
): void {
    const issues = validateProjectMemoryStatusTextPack(languageId, pack, catalog);
    if (issues.length > 0) {
        const summary = issues
            .slice(0, 12)
            .map((issue) => `${issue.path}: ${issue.reason}`)
            .join('; ');
        throw new Error(`Project memory status text pack '${languageId}' is incomplete (${issues.length} issue(s)). ${summary}`);
    }
}
