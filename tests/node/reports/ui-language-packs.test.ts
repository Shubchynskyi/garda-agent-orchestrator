import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_TEXT,
    getLocalUiText,
    normalizeLocalUiLanguage
} from '../../../src/reports/ui/ui-i18n';

test('imported UI language packs are registered beside built-in English and Russian', () => {
    const languageIds = LOCAL_UI_LANGUAGES.map((language) => language.id);
    assert.ok(languageIds.includes('en'));
    assert.ok(languageIds.includes('ru'));
    assert.ok(languageIds.includes('de'));
    assert.ok(languageIds.includes('uk'));
    assert.equal(getLocalUiText('de').tasksTab, 'Aufgaben');
    assert.equal(getLocalUiText('de').backupsTab, 'Backups');
});

test('unknown UI language falls back to English', () => {
    assert.equal(normalizeLocalUiLanguage('xx'), 'en');
    assert.equal(getLocalUiText('xx').tasksTab, 'Tasks');
});

test('every registered UI language pack matches the English key set', () => {
    const englishKeys = Object.keys(LOCAL_UI_TEXT.en).sort();
    for (const language of LOCAL_UI_LANGUAGES) {
        assert.deepEqual(Object.keys(LOCAL_UI_TEXT[language.id]).sort(), englishKeys);
    }
});
