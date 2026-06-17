import type { LocalUiLocalizedText } from '../ui-language-pack-loader';
import { buildWorkflowSettingTextCatalog } from './catalog';
import { EXCLUDED_REVIEW_TYPE_SETTING_ID, KNOWN_REVIEW_TYPE_IDS } from '../../review-type-setting-text';

export interface WorkflowSettingTextValidationIssue {
    languageId: string;
    path: string;
    reason: string;
}

function assertOptionEntry(
    languageId: string,
    settingId: string,
    optionValue: string,
    expected: { label: string; description?: string },
    actual: LocalUiLocalizedText['options'] | undefined,
    issues: WorkflowSettingTextValidationIssue[]
): void {
    const skipDescription = settingId === EXCLUDED_REVIEW_TYPE_SETTING_ID;
    const option = actual?.[optionValue];
    if (!option) {
        issues.push({
            languageId,
            path: `${settingId}.options.${optionValue}`,
            reason: 'missing option translation'
        });
        return;
    }
    if (!option.label?.trim()) {
        issues.push({
            languageId,
            path: `${settingId}.options.${optionValue}.label`,
            reason: 'empty option label'
        });
    }
    if (!skipDescription && !option.description?.trim()) {
        issues.push({
            languageId,
            path: `${settingId}.options.${optionValue}.description`,
            reason: 'empty option description'
        });
    }
    if (option.label === expected.label && languageId !== 'en') {
        issues.push({
            languageId,
            path: `${settingId}.options.${optionValue}.label`,
            reason: 'option label still matches English source'
        });
    }
    if (!skipDescription && option.description === expected.description && languageId !== 'en') {
        issues.push({
            languageId,
            path: `${settingId}.options.${optionValue}.description`,
            reason: 'option description still matches English source'
        });
    }
}

export function validateWorkflowSettingTextPack(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildWorkflowSettingTextCatalog()
): WorkflowSettingTextValidationIssue[] {
    const issues: WorkflowSettingTextValidationIssue[] = [];
    const catalogIds = Object.keys(catalog).sort();
    const packIds = Object.keys(pack).sort();

    for (const settingId of catalogIds) {
        if (!packIds.includes(settingId)) {
            issues.push({ languageId, path: settingId, reason: 'missing setting translation' });
            continue;
        }
        const expected = catalog[settingId];
        const actual = pack[settingId];
        if (!actual.label?.trim() && expected.label?.trim()) {
            issues.push({ languageId, path: `${settingId}.label`, reason: 'empty setting label' });
        }
        if (!actual.description?.trim() && expected.description?.trim()) {
            issues.push({ languageId, path: `${settingId}.description`, reason: 'empty setting description' });
        }
        if (languageId !== 'en' && expected.label && actual.label === expected.label) {
            issues.push({ languageId, path: `${settingId}.label`, reason: 'setting label still matches English source' });
        }
        if (languageId !== 'en' && expected.description && actual.description === expected.description) {
            issues.push({
                languageId,
                path: `${settingId}.description`,
                reason: 'setting description still matches English source'
            });
        }
        for (const [optionValue, optionText] of Object.entries(expected.options || {})) {
            assertOptionEntry(languageId, settingId, optionValue, optionText, actual.options, issues);
        }
    }

    for (const extraId of packIds) {
        if (!catalogIds.includes(extraId)) {
            issues.push({ languageId, path: extraId, reason: 'unexpected extra setting translation' });
        }
    }

    return issues;
}

export function assertWorkflowSettingTextPackComplete(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>,
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildWorkflowSettingTextCatalog()
): void {
    const issues = [
        ...validateWorkflowSettingTextPack(languageId, pack, catalog),
        ...validateExcludedReviewTypeOptionTranslations(languageId, pack)
    ];
    if (issues.length > 0) {
        const summary = issues
            .slice(0, 12)
            .map((issue) => `${issue.path}: ${issue.reason}`)
            .join('; ');
        throw new Error(
            `Workflow setting text pack '${languageId}' is incomplete (${issues.length} issue(s)). ${summary}`
        );
    }
}

export function validateExcludedReviewTypeOptionTranslations(
    languageId: string,
    pack: Readonly<Record<string, LocalUiLocalizedText>>
): WorkflowSettingTextValidationIssue[] {
    const issues: WorkflowSettingTextValidationIssue[] = [];
    const setting = pack[EXCLUDED_REVIEW_TYPE_SETTING_ID];
    if (!setting) {
        issues.push({
            languageId,
            path: EXCLUDED_REVIEW_TYPE_SETTING_ID,
            reason: 'missing excluded review types setting translation'
        });
        return issues;
    }

    for (const reviewType of KNOWN_REVIEW_TYPE_IDS) {
        const option = setting.options?.[reviewType];
        if (!option) {
            issues.push({
                languageId,
                path: `${EXCLUDED_REVIEW_TYPE_SETTING_ID}.options.${reviewType}`,
                reason: 'missing excluded review type option translation'
            });
            continue;
        }
        if (!option.label?.trim()) {
            issues.push({
                languageId,
                path: `${EXCLUDED_REVIEW_TYPE_SETTING_ID}.options.${reviewType}.label`,
                reason: 'empty excluded review type option label'
            });
        }
        if (option.label?.trim().toLowerCase() === reviewType && languageId !== 'en') {
            issues.push({
                languageId,
                path: `${EXCLUDED_REVIEW_TYPE_SETTING_ID}.options.${reviewType}.label`,
                reason: 'excluded review type option label still matches raw review type key'
            });
        }
    }

    return issues;
}
