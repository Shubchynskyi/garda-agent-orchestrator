import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_INIT_SETTING_TEXT, LOCAL_UI_LANGUAGES } from '../../../src/reports/ui';
import { buildInitSettingTextCatalog, listInitSettingTextCatalogIds } from '../../../src/reports/ui/init-setting-text/catalog';
import { loadInitSettingTextTranslations } from '../../../src/reports/ui/init-setting-text/load-translations';
import { assertInitSettingTextPackComplete, validateInitSettingTextPack } from '../../../src/reports/ui/init-setting-text/validate';

const INIT_SETTING_TEXT_CATALOG = buildInitSettingTextCatalog();
const EXPECTED_SETTING_IDS = listInitSettingTextCatalogIds(INIT_SETTING_TEXT_CATALOG);

test('init setting text catalog covers every init setting definition', () => {
    assert.equal(EXPECTED_SETTING_IDS.length, 20);
    assert.ok(EXPECTED_SETTING_IDS.includes('reinit'));
    assert.ok(EXPECTED_SETTING_IDS.includes('agent-init'));
});

test('every non-English UI language has a complete init setting text pack', () => {
    const loaded = loadInitSettingTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing init setting text pack for ${language.id}`);
        assertInitSettingTextPackComplete(language.id, pack, INIT_SETTING_TEXT_CATALOG);
    }
});

test('LOCAL_UI_INIT_SETTING_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_INIT_SETTING_TEXT.en).sort(), EXPECTED_SETTING_IDS);
    assert.equal(LOCAL_UI_INIT_SETTING_TEXT.ru.AssistantLanguage.label, 'Язык ассистента');
    assert.equal(
        LOCAL_UI_INIT_SETTING_TEXT.de.EnforceNoAutoCommit.label,
        'Keine automatischen Commits'
    );
    assert.doesNotMatch(
        LOCAL_UI_INIT_SETTING_TEXT.uk.SourceOfTruth.description || '',
        /Canonical provider file/u
    );
});

test('init setting text packs do not contain unexpected setting ids', () => {
    for (const [languageId, pack] of Object.entries(loadInitSettingTextTranslations())) {
        const issues = validateInitSettingTextPack(languageId, pack, INIT_SETTING_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra init setting translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected setting ids`);
    }
});
