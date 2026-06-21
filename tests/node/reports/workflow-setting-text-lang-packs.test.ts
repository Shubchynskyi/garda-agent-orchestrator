import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_SETTING_TEXT } from '../../../src/reports/ui';
import { buildWorkflowSettingTextCatalog, listWorkflowSettingTextCatalogIds } from '../../../src/reports/ui/workflow-setting-text/catalog';
import { loadWorkflowSettingTextTranslations } from '../../../src/reports/ui/workflow-setting-text/load-translations';
import { assertWorkflowSettingTextPackComplete, validateWorkflowSettingTextPack } from '../../../src/reports/ui/workflow-setting-text/validate';

const WORKFLOW_SETTING_TEXT_CATALOG = buildWorkflowSettingTextCatalog();
const EXPECTED_SETTING_IDS = listWorkflowSettingTextCatalogIds(WORKFLOW_SETTING_TEXT_CATALOG);

test('workflow setting text catalog covers every workflow setting definition plus compile-gate fallback', () => {
    assert.equal(EXPECTED_SETTING_IDS.length, 37);
    assert.ok(EXPECTED_SETTING_IDS.includes('compile-gate-command-fallback'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-timeout-blocker'));
    assert.ok(EXPECTED_SETTING_IDS.includes('full-suite-timeout-retry-count'));
});

test('every non-English UI language has a complete workflow setting text pack', () => {
    const loaded = loadWorkflowSettingTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing workflow setting text pack for ${language.id}`);
        assertWorkflowSettingTextPackComplete(language.id, pack, WORKFLOW_SETTING_TEXT_CATALOG);
    }
});

test('LOCAL_UI_SETTING_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_SETTING_TEXT.en).sort(), EXPECTED_SETTING_IDS);
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['full-suite-enabled'].options?.true?.description,
        'Настроенная команда полной проверки обязательна в жизненном цикле задачи.'
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.de['full-suite-enabled'].options?.false?.label,
        'Aus'
    );
    assert.doesNotMatch(
        LOCAL_UI_SETTING_TEXT.uk['full-suite-enabled'].description || '',
        /Controls whether the configured full-suite/u
    );
});

test('excluded review type options are translated with human-readable labels', () => {
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.code?.label, 'Ревью кода');
    assert.match(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].description || '',
        /Множественный выбор/u
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.security?.label,
        'Ревью безопасности'
    );
    assert.equal(
        LOCAL_UI_SETTING_TEXT.ru['review-cycle-excluded-review-types'].options?.code?.description,
        undefined
    );
});

test('workflow setting text packs do not contain unexpected setting ids', () => {
    for (const [languageId, pack] of Object.entries(loadWorkflowSettingTextTranslations())) {
        const issues = validateWorkflowSettingTextPack(languageId, pack, WORKFLOW_SETTING_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra setting translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected setting ids`);
    }
});
