import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_CLEANUP_SETTING_TEXT, LOCAL_UI_LANGUAGES } from '../../../src/reports/ui';
import { buildCleanupSettingTextCatalog, listCleanupSettingTextCatalogIds } from '../../../src/reports/ui/cleanup-setting-text/catalog';
import { loadCleanupSettingTextTranslations } from '../../../src/reports/ui/cleanup-setting-text/load-translations';
import { assertCleanupSettingTextPackComplete, validateCleanupSettingTextPack } from '../../../src/reports/ui/cleanup-setting-text/validate';

const CLEANUP_SETTING_TEXT_CATALOG = buildCleanupSettingTextCatalog();
const EXPECTED_SETTING_IDS = listCleanupSettingTextCatalogIds(CLEANUP_SETTING_TEXT_CATALOG);

test('cleanup setting text catalog covers every cleanup setting definition', () => {
    assert.equal(EXPECTED_SETTING_IDS.length, 16);
    assert.ok(EXPECTED_SETTING_IDS.includes('daily_maintenance_enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('manual_runtime_cleanup'));
});

test('every non-English UI language has a complete cleanup setting text pack', () => {
    const loaded = loadCleanupSettingTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing cleanup setting text pack for ${language.id}`);
        assertCleanupSettingTextPackComplete(language.id, pack, CLEANUP_SETTING_TEXT_CATALOG);
    }
});

test('LOCAL_UI_CLEANUP_SETTING_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_CLEANUP_SETTING_TEXT.en).sort(), EXPECTED_SETTING_IDS);
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.daily_maintenance_enabled.label,
        'Ежедневное обслуживание'
    );
    assert.doesNotMatch(
        LOCAL_UI_CLEANUP_SETTING_TEXT.de.eligible_older_than_days.description || '',
        /A task must be at least this many days old/u
    );
});

test('cleanup setting text packs do not contain unexpected setting ids', () => {
    for (const [languageId, pack] of Object.entries(loadCleanupSettingTextTranslations())) {
        const issues = validateCleanupSettingTextPack(languageId, pack, CLEANUP_SETTING_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra cleanup setting translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected setting ids`);
    }
});
